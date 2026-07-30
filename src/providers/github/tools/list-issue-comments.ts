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
  githubBotListIssueCommentsToolMetadata,
  githubBotListIssueCommentsToolName
} from "../../../shared/github-bot-list-issue-comments-tool.js";

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

export interface ListIssueCommentsParams {
  repository: string;
  issueNumber: number;
  page?: number;
  perPage?: number;
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
  if (p.page !== undefined && (typeof p.page !== "number" || !Number.isInteger(p.page) || p.page <= 0)) {
    return { ok: false, error: "page must be a positive integer if provided" };
  }
  if (
    p.perPage !== undefined &&
    (typeof p.perPage !== "number" || !Number.isInteger(p.perPage) || p.perPage <= 0 || p.perPage > MAX_PER_PAGE)
  ) {
    return { ok: false, error: `perPage must be a positive integer up to ${MAX_PER_PAGE} if provided` };
  }
  const validated: ListIssueCommentsParams = {
    repository: p.repository,
    issueNumber: p.issueNumber,
    page: p.page as number | undefined,
    perPage: p.perPage as number | undefined
  };
  return { ok: true, params: validated };
}

function parseHasMore(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return /rel="next"/.test(linkHeader);
}

export const githubListIssueCommentsToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotListIssueCommentsToolName,
  metadata: githubBotListIssueCommentsToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as ListIssueCommentsParams;
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
    const validated = execution.params as ListIssueCommentsParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const page = validated.page ?? 1;
    const perPage = validated.perPage ?? DEFAULT_PER_PAGE;
    const apiUrl =
      `https://api.github.com/repos/${owner}/${repo}/issues/${validated.issueNumber}/comments` +
      `?page=${page}&per_page=${perPage}`;

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
      ctx.logger.error(`github_bot_list_issue_comments network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} listing issue comments. ${details}`.trim()
      };
    }

    const hasMore = parseHasMore(response.headers.get("Link"));
    const items = (await response.json()) as Array<{
      id: number;
      user: { login: string } | null;
      body: string;
      created_at: string;
      html_url: string;
    }>;

    const comments = items.map((c) => ({
      id: c.id,
      author: c.user?.login ?? null,
      body: c.body,
      createdAt: c.created_at,
      url: c.html_url
    }));

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Listed comments on issue #${validated.issueNumber} in ${repository.fullName}`,
      entityType: "issue_comment_list",
      entityId: String(validated.issueNumber),
      metadata: {
        repository: repository.fullName,
        issueNumber: validated.issueNumber,
        page,
        perPage,
        count: comments.length,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`Listed ${comments.length} comments on issue #${validated.issueNumber} in ${repository.fullName}`);

    return {
      content: `Found ${comments.length} comment(s) on issue #${validated.issueNumber}`,
      data: {
        comments,
        page,
        perPage,
        hasMore
      }
    };
  }
};
