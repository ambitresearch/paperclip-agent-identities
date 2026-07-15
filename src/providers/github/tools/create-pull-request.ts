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

export interface CreatePullRequestParams {
  repository: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  paperclipIssueId?: string;
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
  const validated: CreatePullRequestParams = {
    repository: p.repository,
    head: p.head,
    base: p.base,
    title: p.title,
    body: p.body as string | undefined,
    draft: p.draft as boolean | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
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
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;

    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
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
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_create_pull_request network failure: ${reason}`);
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
      return {
        error: `GitHub API returned ${response.status} creating the pull request. ${details}`.trim()
      };
    }

    const created = (await response.json()) as {
      number: number;
      html_url: string;
      state: string;
      draft: boolean;
      head: { ref: string };
      base: { ref: string };
    };

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
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
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
        base: created.base.ref
      }
    };
  }
};
