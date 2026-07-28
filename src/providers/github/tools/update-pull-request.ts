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
import { appendAiAuthorshipFooter } from "../../../shared/github-ai-authorship-footer.js";
import { executeGitHubGraphQL } from "../graphql.js";
import {
  githubBotUpdatePullRequestToolMetadata,
  githubBotUpdatePullRequestToolName
} from "../../../shared/github-bot-update-pull-request-tool.js";

export type UpdatePullRequestState = "open" | "closed";

export interface UpdatePullRequestParams {
  repository: string;
  pullNumber: number;
  title?: string;
  body?: string;
  base?: string;
  state?: UpdatePullRequestState;
  draft?: boolean;
  llmModel?: string;
  paperclipIssueId?: string;
}

const VALID_STATES: readonly UpdatePullRequestState[] = ["open", "closed"];

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
  if (p.title !== undefined && typeof p.title !== "string") {
    return { ok: false, error: "title must be a string if provided" };
  }
  if (p.body !== undefined && typeof p.body !== "string") {
    return { ok: false, error: "body must be a string if provided" };
  }
  if (p.base !== undefined && typeof p.base !== "string") {
    return { ok: false, error: "base must be a string if provided" };
  }
  if (p.state !== undefined && (typeof p.state !== "string" || !VALID_STATES.includes(p.state as UpdatePullRequestState))) {
    return { ok: false, error: 'state must be "open" or "closed" if provided' };
  }
  if (p.draft !== undefined && typeof p.draft !== "boolean") {
    return { ok: false, error: "draft must be a boolean if provided" };
  }
  if (p.llmModel !== undefined && typeof p.llmModel !== "string") {
    return { ok: false, error: "llmModel must be a string if provided" };
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }
  if (
    p.title === undefined &&
    p.body === undefined &&
    p.base === undefined &&
    p.state === undefined &&
    p.draft === undefined
  ) {
    return { ok: false, error: "at least one of title, body, base, state, draft must be provided" };
  }
  const validated: UpdatePullRequestParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    title: p.title as string | undefined,
    body: p.body as string | undefined,
    base: p.base as string | undefined,
    state: p.state as UpdatePullRequestState | undefined,
    draft: p.draft as boolean | undefined,
    llmModel: p.llmModel as string | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

async function readGitHubApiError(response: Response): Promise<string> {
  try {
    const errBody = (await response.json()) as { message?: string; errors?: unknown };
    const parts: string[] = [];
    if (errBody.message) parts.push(errBody.message);
    if (errBody.errors) parts.push(JSON.stringify(errBody.errors));
    return parts.join(" ");
  } catch {
    return await response.text().catch(() => "");
  }
}

interface GitHubHttpFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

function githubRestHeaders(token: string): Record<string, string> {
  return {
    "Accept": "application/vnd.github+json",
    "Authorization": `Bearer ${token}`,
    "User-Agent": "paperclip-agent-identities/github-api",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json"
  };
}

/**
 * GitHub's REST `PATCH /pulls/{n}` endpoint does not accept a `draft` field —
 * only `title`, `body`, `state`, `base`, and `maintainer_can_modify`.
 * Draft <-> ready-for-review is exposed only via the GraphQL mutations
 * `convertPullRequestToDraft` / `markPullRequestReadyForReview`, both of
 * which take the PR's GraphQL node id rather than its number.
 */
async function toggleDraftState(
  ctx: { http: { fetch: GitHubHttpFetch } },
  token: string,
  nodeId: string,
  draft: boolean
): Promise<{ ok: true } | { ok: false; error: string }> {
  const mutation = draft
    ? `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }`
    : `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { id } } }`;

  const result = await executeGitHubGraphQL<{ convertPullRequestToDraft?: unknown; markPullRequestReadyForReview?: unknown }>(
    ctx as never,
    token,
    mutation,
    { id: nodeId }
  );
  if (!result.ok) {
    return { ok: false, error: `Failed to toggle draft state: ${result.error}` };
  }
  return { ok: true };
}

export const githubUpdatePullRequestToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotUpdatePullRequestToolName,
  metadata: githubBotUpdatePullRequestToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as UpdatePullRequestParams;
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
    const validated = execution.params as UpdatePullRequestParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;

    const patchBody: Record<string, unknown> = {};
    if (validated.title !== undefined) patchBody.title = validated.title;
    if (validated.body !== undefined) {
      patchBody.body = appendAiAuthorshipFooter(validated.body, validated.llmModel);
    }
    if (validated.base !== undefined) patchBody.base = validated.base;
    if (validated.state !== undefined) patchBody.state = validated.state;

    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${validated.pullNumber}`;
    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
        method: "PATCH",
        headers: githubRestHeaders(token),
        body: JSON.stringify(patchBody)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_update_pull_request network failure: ${reason}`);
      return { error: "GitHub API request failed before a response was received." };
    }

    if (!response.ok) {
      const details = await readGitHubApiError(response);
      return {
        error: `GitHub API returned ${response.status} updating pull request #${validated.pullNumber}. ${details}`.trim()
      };
    }

    let updated = (await response.json()) as {
      number: number;
      html_url: string;
      state: string;
      draft: boolean;
      title: string;
      node_id: string;
      head: { ref: string };
      base: { ref: string };
    };

    if (validated.draft !== undefined && updated.draft !== validated.draft) {
      const toggled = await toggleDraftState(ctx, token, updated.node_id, validated.draft);
      if (!toggled.ok) {
        return { error: toggled.error };
      }

      // Re-fetch so the returned data reflects the post-toggle draft/state,
      // since the GraphQL mutation response shape differs from the REST PR
      // representation used for the rest of this tool's output.
      let refetch: Response;
      try {
        refetch = await ctx.http.fetch(apiUrl, {
          method: "GET",
          headers: githubRestHeaders(token)
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown network error";
        ctx.logger.error(`github_bot_update_pull_request post-toggle refetch failure: ${reason}`);
        return { error: "GitHub API request failed before a response was received." };
      }
      if (!refetch.ok) {
        const details = await readGitHubApiError(refetch);
        return {
          error: `GitHub API returned ${refetch.status} re-fetching pull request #${validated.pullNumber} after draft toggle. ${details}`.trim()
        };
      }
      updated = (await refetch.json()) as typeof updated;
    }

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Updated pull request #${updated.number} in ${repository.fullName}`,
      entityType: "pull_request",
      entityId: String(updated.number),
      metadata: {
        repository: repository.fullName,
        prNumber: updated.number,
        prUrl: updated.html_url,
        state: updated.state,
        draft: updated.draft,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(`Updated pull request #${updated.number} in ${repository.fullName}`);

    return {
      content: `Updated PR #${updated.number}: ${updated.html_url}`,
      data: {
        number: updated.number,
        url: updated.html_url,
        state: updated.state,
        draft: updated.draft,
        title: updated.title,
        head: updated.head.ref,
        base: updated.base.ref
      }
    };
  }
};
