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
  githubBotAssignToCurrentUserToolMetadata,
  githubBotAssignToCurrentUserToolName
} from "../../../shared/github-bot-assign-to-current-user-tool.js";

export interface AssignToCurrentUserParams {
  repository: string;
  issueNumber: number;
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
  if (typeof p.issueNumber !== "number" || !Number.isInteger(p.issueNumber) || p.issueNumber <= 0) {
    return { ok: false, error: "issueNumber must be a positive integer" };
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }
  const validated: AssignToCurrentUserParams = {
    repository: p.repository,
    issueNumber: p.issueNumber,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

/**
 * Assigns the issue/PR to the calling agent's own configured GitHub identity.
 *
 * Security note (DRO-1169): there is deliberately NO `username`/`assignee`
 * parameter on this tool. The only assignee this action can ever produce is
 * `execution.identity.identity.githubUsername` — the value resolved from the
 * per-agent GitHub App identity config (see `config.ts` /
 * `resolveAgentIdentityFromToolRunContext`), never a caller-supplied string,
 * an environment variable, or a personal-access-token-associated account.
 * This makes "assign to some other user" and "silently fall back to a
 * personal token's account" both structurally impossible rather than merely
 * validated at runtime — see the provider spec test for a proof that the
 * assignee sent to GitHub is always and only the configured identity.
 *
 * GitHub's `POST /issues/{issue_number}/assignees` endpoint *adds* up to 10
 * assignees without removing any existing ones, so "preserve existing
 * assignees" falls out of using that endpoint rather than requiring a
 * read-then-write against the current assignee list.
 */
export const githubAssignToCurrentUserToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotAssignToCurrentUserToolName,
  metadata: githubBotAssignToCurrentUserToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as AssignToCurrentUserParams;
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
    const validated = execution.params as AssignToCurrentUserParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    // Always and only the calling agent's own configured GitHub identity.
    const githubUsername = execution.identity.identity.githubUsername;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${validated.issueNumber}/assignees`;

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
        body: JSON.stringify({ assignees: [githubUsername] })
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_assign_to_current_user network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} assigning issue #${validated.issueNumber}. ${details}`.trim()
      };
    }

    const updated = (await response.json()) as {
      number: number;
      html_url: string;
      assignees?: Array<{ login: string }>;
    };
    const assigneeLogins = (updated.assignees ?? []).map((a) => a.login);

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Assigned ${githubUsername} to issue #${updated.number} in ${repository.fullName}`,
      entityType: "issue",
      entityId: String(updated.number),
      metadata: {
        repository: repository.fullName,
        issueNumber: updated.number,
        issueUrl: updated.html_url,
        assignee: githubUsername,
        assignees: assigneeLogins,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(`Assigned ${githubUsername} to issue #${updated.number} in ${repository.fullName}`);

    return {
      content: `Assigned @${githubUsername} to #${updated.number}: ${updated.html_url}`,
      data: {
        number: updated.number,
        url: updated.html_url,
        assignees: assigneeLogins
      }
    };
  }
};
