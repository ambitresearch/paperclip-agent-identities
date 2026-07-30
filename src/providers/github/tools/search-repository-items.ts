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
  githubBotSearchRepositoryItemsToolMetadata,
  githubBotSearchRepositoryItemsToolName
} from "../../../shared/github-bot-search-repository-items-tool.js";

const MAX_QUERY_LENGTH = 256;
const MAX_PAGE = 34; // GitHub Search API caps results at 1000 total (34 pages of 30)

export interface SearchRepositoryItemsParams {
  repository: string;
  query: string;
  type: "issue" | "pr";
  maxResults: number;
  page: number;
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.repository || typeof p.repository !== "string") {
    return { ok: false, error: 'repository is required (e.g. "my-org/my-repo")' };
  }
  if (!p.query || typeof p.query !== "string") {
    return { ok: false, error: "query is required" };
  }
  if (p.query.length > MAX_QUERY_LENGTH) {
    return { ok: false, error: `query must be ${MAX_QUERY_LENGTH} characters or fewer` };
  }
  // Repository scoping is enforced by appending `repo:owner/name` to the caller's query.
  // That only holds if the caller cannot introduce their own scope or boolean alternation:
  // GitHub search honors multiple `repo:`/`org:`/`user:` qualifiers and `OR`/`NOT`, either of
  // which can widen results beyond the resolved repository. Reject both up front.
  if (/\b(?:OR|NOT)\b/.test(p.query)) {
    return {
      ok: false,
      error: "query must not contain the boolean operators OR/NOT; they can escape repository scoping"
    };
  }
  if (/(?:^|\s)-?(?:repo|org|user|owner):/i.test(p.query)) {
    return {
      ok: false,
      error:
        "query must not contain repo:, org:, user:, or owner: qualifiers; repository scoping is applied automatically"
    };
  }
  const type = p.type ?? "issue";
  if (type !== "issue" && type !== "pr") {
    return { ok: false, error: 'type must be "issue" or "pr"' };
  }
  const maxResults = p.maxResults ?? 10;
  if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 30) {
    return { ok: false, error: "maxResults must be an integer between 1 and 30" };
  }
  const page = p.page ?? 1;
  if (typeof page !== "number" || !Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    return { ok: false, error: `page must be an integer between 1 and ${MAX_PAGE}` };
  }
  const validated: SearchRepositoryItemsParams = {
    repository: p.repository,
    query: p.query,
    type: type as "issue" | "pr",
    maxResults: maxResults as number,
    page: page as number
  };
  return { ok: true, params: validated };
}

export const githubSearchRepositoryItemsToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotSearchRepositoryItemsToolName,
  metadata: githubBotSearchRepositoryItemsToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as SearchRepositoryItemsParams;
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
    const validated = execution.params as SearchRepositoryItemsParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;

    const itemType = validated.type === "pr" ? "pr" : "issue";
    const q = encodeURIComponent(`${validated.query} repo:${owner}/${repo} type:${itemType}`);
    const apiUrl =
      `https://api.github.com/search/issues?q=${q}` +
      `&per_page=${validated.maxResults}&page=${validated.page}`;

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
      ctx.logger.error(`github_bot_search_repository_items network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} searching repository items. ${details}`.trim()
      };
    }

    const result = (await response.json()) as {
      total_count: number;
      items: Array<{
        number: number;
        title: string;
        state: string;
        html_url: string;
        labels: Array<{ name: string } | string>;
        assignees: Array<{ login: string }>;
      }>;
    };

    const items = result.items.map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      url: item.html_url,
      labels: item.labels.map((l) => (typeof l === "string" ? l : l.name)),
      assignees: item.assignees.map((a) => a.login)
    }));
    const hasMore = validated.page * validated.maxResults < result.total_count;

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Searched ${validated.type === "pr" ? "pull requests" : "issues"} in ${repository.fullName} for "${validated.query}" — ${items.length} result(s)`,
      entityType: "repository",
      entityId: repository.fullName,
      metadata: {
        repository: repository.fullName,
        query: validated.query,
        type: validated.type,
        resultCount: items.length,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`Searched ${validated.type} in ${repository.fullName}: ${items.length} result(s)`);

    return {
      content: `Found ${result.total_count} matching ${validated.type === "pr" ? "pull requests" : "issues"} (showing ${items.length})`,
      data: {
        totalCount: result.total_count,
        page: validated.page,
        perPage: validated.maxResults,
        hasMore,
        items
      }
    };
  }
};
