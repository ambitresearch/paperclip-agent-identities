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
  githubBotListPullRequestFilesToolMetadata,
  githubBotListPullRequestFilesToolName
} from "../../../shared/github-bot-list-pull-request-files-tool.js";

const DEFAULT_PER_PAGE = 30;
const MAX_PER_PAGE = 100;

export interface ListPullRequestFilesParams {
  repository: string;
  pullNumber: number;
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
  if (typeof p.pullNumber !== "number" || !Number.isInteger(p.pullNumber) || p.pullNumber <= 0) {
    return { ok: false, error: "pullNumber must be a positive integer" };
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
  const validated: ListPullRequestFilesParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    page: p.page as number | undefined,
    perPage: p.perPage as number | undefined
  };
  return { ok: true, params: validated };
}

function parseHasMore(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return /rel="next"/.test(linkHeader);
}

export const githubListPullRequestFilesToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotListPullRequestFilesToolName,
  metadata: githubBotListPullRequestFilesToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as ListPullRequestFilesParams;
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
    const validated = execution.params as ListPullRequestFilesParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const page = validated.page ?? 1;
    const perPage = validated.perPage ?? DEFAULT_PER_PAGE;
    const apiUrl =
      `https://api.github.com/repos/${owner}/${repo}/pulls/${validated.pullNumber}/files` +
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
      ctx.logger.error(`github_bot_list_pull_request_files network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} listing pull request files. ${details}`.trim()
      };
    }

    const hasMore = parseHasMore(response.headers.get("Link"));
    const items = (await response.json()) as Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      changes: number;
      patch?: string;
    }>;

    const files = items.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch ?? null
    }));

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Listed files on pull request #${validated.pullNumber} in ${repository.fullName}`,
      entityType: "pull_request_files",
      entityId: String(validated.pullNumber),
      metadata: {
        repository: repository.fullName,
        prNumber: validated.pullNumber,
        page,
        perPage,
        count: files.length,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`Listed ${files.length} files on pull request #${validated.pullNumber} in ${repository.fullName}`);

    return {
      content: `Found ${files.length} changed file(s) on PR #${validated.pullNumber}`,
      data: {
        files,
        page,
        perPage,
        hasMore
      }
    };
  }
};
