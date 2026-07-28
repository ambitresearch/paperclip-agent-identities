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
  githubBotGetPullRequestToolMetadata,
  githubBotGetPullRequestToolName
} from "../../../shared/github-bot-get-pull-request-tool.js";

export interface GetPullRequestParams {
  repository: string;
  pullNumber: number;
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.repository || typeof p.repository !== "string") {
    return { ok: false, error: 'repository is required (e.g. "my-org/my-repo")' };
  }
  if (typeof p.pullNumber !== "number" || !Number.isInteger(p.pullNumber) || p.pullNumber <= 0) {
    return { ok: false, error: "pullNumber must be a positive integer" };
  }
  const validated: GetPullRequestParams = {
    repository: p.repository,
    pullNumber: p.pullNumber
  };
  return { ok: true, params: validated };
}

export const githubGetPullRequestToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotGetPullRequestToolName,
  metadata: githubBotGetPullRequestToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as GetPullRequestParams;
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
    const validated = execution.params as GetPullRequestParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${validated.pullNumber}`;

    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
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
      ctx.logger.error(`github_bot_get_pull_request network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} fetching the pull request. ${details}`.trim()
      };
    }

    const pr = (await response.json()) as {
      number: number;
      title: string;
      body: string | null;
      state: string;
      html_url: string;
      draft: boolean;
      merged: boolean;
      mergeable: boolean | null;
      mergeable_state: string;
      head: { ref: string };
      base: { ref: string };
      requested_reviewers: Array<{ login: string }>;
    };

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Fetched pull request #${validated.pullNumber} in ${repository.fullName}`,
      entityType: "pull_request",
      entityId: String(pr.number),
      metadata: {
        repository: repository.fullName,
        prNumber: validated.pullNumber,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`Fetched pull request #${validated.pullNumber} in ${repository.fullName}`);

    return {
      content: `PR #${pr.number}: ${pr.title} (${pr.state})`,
      data: {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        url: pr.html_url,
        draft: pr.draft,
        merged: pr.merged,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeable_state,
        head: pr.head.ref,
        base: pr.base.ref,
        requestedReviewers: pr.requested_reviewers.map((r) => r.login)
      }
    };
  }
};
