import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import type { GitHubRepoRef } from "../repo-ref.js";
import { normalizeGitHubRepoRef } from "../repo-ref.js";
import {
  githubBotCreatePullRequestToolMetadata,
  githubBotCreatePullRequestToolName
} from "../../../shared/github-bot-create-pull-request-tool.js";
import {
  buildGitAuthEnvironment,
  redactSecretText,
  resolveWorkspacePath,
  runGitCommandForTools,
  toBranchRef,
  validateBranchName,
  validateRemoteName
} from "./push-branch.js";
import { persistGithubLink } from "../link-storage.js";

export interface CreatePullRequestParams {
  repository: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  paperclipIssueId?: string;
  // Optional exact-commit publish controls. When omitted, behavior is
  // unchanged from the pre-DRO-1173 tool: no local push is attempted and the
  // caller is expected to have already pushed `head` themselves.
  remote?: string;
  commit?: string;
  dryRun?: boolean;
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.repository || typeof p.repository !== "string") {
    return { ok: false, error: 'repository is required (e.g. "my-org/my-repo")' };
  }
  if (!p.head || typeof p.head !== "string") {
    return { ok: false, error: "head branch is required" };
  }
  if (!p.base || typeof p.base !== "string") {
    return { ok: false, error: "base branch is required" };
  }
  if (!p.title || typeof p.title !== "string") {
    return { ok: false, error: "title is required" };
  }
  if (p.body !== undefined && typeof p.body !== "string") {
    return { ok: false, error: "body must be a string if provided" };
  }
  if (p.draft !== undefined && typeof p.draft !== "boolean") {
    return { ok: false, error: "draft must be a boolean if provided" };
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }
  if (p.remote !== undefined && typeof p.remote !== "string") {
    return { ok: false, error: "remote must be a string if provided" };
  }
  if (p.commit !== undefined && typeof p.commit !== "string") {
    return { ok: false, error: "commit must be a string if provided" };
  }
  if (p.dryRun !== undefined && typeof p.dryRun !== "boolean") {
    return { ok: false, error: "dryRun must be a boolean if provided" };
  }
  if (p.dryRun === true && p.commit === undefined) {
    return { ok: false, error: "dryRun requires commit to be provided; dryRun has no effect without an exact-commit publish." };
  }
  const validated: CreatePullRequestParams = {
    repository: p.repository,
    head: p.head,
    base: p.base,
    title: p.title,
    body: p.body as string | undefined,
    draft: p.draft as boolean | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined,
    remote: p.remote as string | undefined,
    commit: p.commit as string | undefined,
    dryRun: p.dryRun as boolean | undefined
  };
  return { ok: true, params: validated };
}

async function getRemoteRefSha(input: {
  fetchImpl: PluginContext["http"]["fetch"];
  token: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<{ exists: boolean; sha: string | null; error?: string }> {
  const { fetchImpl, token, owner, repo, branch } = input;
  const url = `https://api.github.com/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "paperclip-agent-identities/github-api",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown network error";
    return { exists: false, sha: null, error: `network failure resolving remote ref: ${reason}` };
  }
  if (response.status === 404) {
    return { exists: false, sha: null };
  }
  if (!response.ok) {
    return { exists: false, sha: null, error: `GitHub API returned ${response.status} resolving remote ref.` };
  }
  const body = (await response.json()) as { object?: { sha?: string } };
  const sha = body.object?.sha ?? null;
  return { exists: sha !== null, sha };
}

async function deleteRemoteRef(input: {
  fetchImpl: PluginContext["http"]["fetch"];
  token: string;
  owner: string;
  repo: string;
  branch: string;
}): Promise<{ ok: boolean; error?: string }> {
  const { fetchImpl, token, owner, repo, branch } = input;
  const url = `https://api.github.com/repos/${owner}/${repo}/git/refs/${encodeURIComponent(`heads/${branch}`)}`;
  try {
    const response = await fetchImpl(url, {
      method: "DELETE",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "User-Agent": "paperclip-agent-identities/github-api",
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    if (!response.ok && response.status !== 404) {
      return { ok: false, error: `GitHub API returned ${response.status} deleting rollback branch.` };
    }
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown network error";
    return { ok: false, error: `network failure deleting rollback branch: ${reason}` };
  }
}

export const githubCreatePullRequestToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotCreatePullRequestToolName,
  metadata: githubBotCreatePullRequestToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as CreatePullRequestParams;
    const ref = normalizeGitHubRepoRef(params.repository);
    if (!ref) {
      return { ok: false, error: "Invalid repository format" };
    }
    return { ok: true, ref };
  },
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef>
  ): Promise<unknown> {
    if (execution.token === null) {
      return { error: "Internal error: missing resolved credential." };
    }
    const token = execution.token;
    const ctx = execution.ctx;
    const runCtx = execution.runCtx;
    const validated = execution.params as CreatePullRequestParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const fetchImpl = ctx.http.fetch;

    // ---- Optional exact-commit publish step (DRO-1173) ----
    // When `commit` is provided, this tool publishes the local branch at that
    // exact commit before creating the PR, reusing push-branch.ts's git
    // plumbing, then verifies the remote branch landed at that commit. If PR
    // creation subsequently fails, it rolls back the branch it just created
    // (but never deletes a branch that already existed remotely).
    let pushedNewBranch = false;
    let publishedSha: string | null = null;

    if (validated.commit !== undefined) {
      const branch = validateBranchName(validated.head);
      if (!branch) {
        return { error: "Invalid head branch. Use a non-empty branch name without whitespace." };
      }
      const remoteName = validateRemoteName(validated.remote ?? "origin");
      if (!remoteName) {
        return { error: "Invalid remote. Use a non-empty remote name without whitespace." };
      }

      const workspace = await resolveWorkspacePath(ctx, runCtx);
      if (!workspace) {
        return { error: "No execution workspace is configured for this run, and no primary workspace is configured for this project." };
      }
      const workspacePath = workspace;

      const headResult = await runGitCommandForTools({ args: ["rev-parse", "HEAD"], cwd: workspacePath });
      if (headResult.exitCode !== 0) {
        return { error: "Unable to resolve local HEAD commit." };
      }
      const localSha = headResult.stdout.trim();
      if (localSha !== validated.commit) {
        return {
          error:
            `Local HEAD (${localSha}) does not match the requested exact commit (${validated.commit}). ` +
            "Refusing to publish a different commit than requested."
        };
      }

      const preExisting = await getRemoteRefSha({ fetchImpl, token, owner, repo, branch });
      if (preExisting.error) {
        return { error: preExisting.error };
      }

      let authEnv: Awaited<ReturnType<typeof buildGitAuthEnvironment>>;
      try {
        authEnv = await buildGitAuthEnvironment(token);
      } catch (error) {
        const message = redactSecretText(error instanceof Error ? error.message : String(error), [token]);
        return { error: `git auth setup failed: ${message}` };
      }

      try {
        const dryRun = validated.dryRun === true;
        const pushArgs = ["-c", "credential.helper=", "push"];
        if (dryRun) {
          pushArgs.push("--dry-run");
        }
        pushArgs.push(`https://github.com/${repository.fullName}.git`);
        pushArgs.push(`${localSha}:${toBranchRef(branch)}`);

        const pushResult = await runGitCommandForTools({
          args: pushArgs,
          cwd: workspacePath,
          env: authEnv.env
        });

        const redactedStdout = redactSecretText(pushResult.stdout, [token]);
        const redactedStderr = redactSecretText(pushResult.stderr, [token]);

        if (pushResult.exitCode !== 0) {
          return {
            error: `git push failed for '${repository.fullName}' branch '${branch}' at commit '${localSha}'.`,
            data: { stdout: redactedStdout, stderr: redactedStderr }
          };
        }

        if (dryRun) {
          return {
            content: `Dry-run publish succeeded for ${repository.fullName}:${branch} at ${localSha}.`,
            data: { repository: repository.fullName, branch, commit: localSha, dryRun: true }
          };
        }
      } finally {
        await authEnv.cleanup();
      }

      pushedNewBranch = !preExisting.exists;
      publishedSha = localSha;

      const verified = await getRemoteRefSha({ fetchImpl, token, owner, repo, branch });
      if (verified.error) {
        if (pushedNewBranch) {
          await deleteRemoteRef({ fetchImpl, token, owner, repo, branch });
        }
        return { error: `Push succeeded but remote verification failed: ${verified.error}` };
      }
      if (verified.sha !== localSha) {
        if (pushedNewBranch) {
          await deleteRemoteRef({ fetchImpl, token, owner, repo, branch });
        }
        return {
          error:
            `Push succeeded but the remote branch '${branch}' landed at '${verified.sha ?? "(missing)"}', ` +
            `not the requested commit '${localSha}'.`
        };
      }
    }

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;

    let response: Response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "paperclip-agent-identities/github-api",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          title: validated.title,
          body: validated.body ?? "",
          head: validated.head,
          base: validated.base,
          draft: validated.draft ?? false
        })
      });
    } catch (error) {
      // Fetch exceptions can embed the outgoing request (including the Authorization
      // header), so redact the installation token before this reaches the log sink.
      const reason = redactSecretText(
        error instanceof Error ? error.message : "Unknown network error",
        [token]
      );
      ctx.logger.error(`github_bot_create_pull_request network failure: ${reason}`);
      if (pushedNewBranch) {
        await deleteRemoteRef({ fetchImpl, token, owner, repo, branch: validated.head });
      }
      return { error: "GitHub API request failed before a response was received." };
    }

    if (!response.ok) {
      let details = "";
      try {
        const errBody = (await response.json()) as { message?: string; errors?: unknown };
        const parts: string[] = [];
        if (errBody.message) parts.push(errBody.message);
        if (errBody.errors) parts.push(JSON.stringify(errBody.errors));
        details = parts.join(" ");
      } catch {
        details = await response.text().catch(() => "");
      }

      let rollback: { attempted: boolean; ok?: boolean; error?: string } = { attempted: false };
      if (pushedNewBranch) {
        const result = await deleteRemoteRef({ fetchImpl, token, owner, repo, branch: validated.head });
        rollback = { attempted: true, ok: result.ok, error: result.error };
      }

      return {
        error: `GitHub API returned ${response.status} creating the pull request. ${details}`.trim(),
        data: { rollback }
      };
    }

    const created = (await response.json()) as {
      number: number;
      html_url: string;
      state: string;
      draft: boolean;
      head: { ref: string; sha?: string };
      base: { ref: string };
    };

    // ---- Atomic "create then link" step (DRO-1164 review follow-up) ----
    // The PR now exists on GitHub. If a paperclipIssueId was supplied,
    // persist the link in the same call rather than requiring a second,
    // separate github_bot_link_github_item invocation. A link-persistence
    // failure here is reported back to the caller (so it can retry the
    // link, e.g. via github_bot_link_github_item) but never rolls back or
    // fails the already-created PR -- the PR is a real, valuable side
    // effect on GitHub, whereas the link is local bookkeeping metadata.
    let linkResult: { ok: boolean; error?: string } | undefined;
    if (validated.paperclipIssueId) {
      const persisted = await persistGithubLink({
        ctx,
        runCtx,
        paperclipIssueId: validated.paperclipIssueId,
        githubUrl: created.html_url
      });
      linkResult = { ok: persisted.ok, error: persisted.error };
      if (!persisted.ok) {
        ctx.logger.error(
          `github_bot_create_pull_request: PR #${created.number} created but linking to Paperclip issue ` +
            `${validated.paperclipIssueId} failed: ${persisted.error ?? "unknown error"}`
        );
      }
    }

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Created pull request #${created.number} in ${repository.fullName}`,
      entityType: "pull_request",
      entityId: String(created.number),
      metadata: {
        repository: repository.fullName,
        prNumber: created.number,
        prUrl: created.html_url,
        head: created.head.ref,
        base: created.base.ref,
        draft: created.draft,
        agentId: runCtx.agentId,
        ...(publishedSha ? { publishedCommit: publishedSha } : {}),
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {}),
        ...(linkResult ? { linked: linkResult.ok } : {})
      }
    });
    ctx.logger.info(`Created pull request #${created.number} in ${repository.fullName}`);

    return {
      content: `Created PR #${created.number}: ${created.html_url}`,
      data: {
        number: created.number,
        url: created.html_url,
        state: created.state,
        draft: created.draft,
        head: created.head.ref,
        base: created.base.ref,
        ...(publishedSha ? { commit: publishedSha } : {}),
        ...(linkResult ? { linked: linkResult.ok, linkError: linkResult.error } : {})
      }
    };
  }
};
