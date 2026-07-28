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
import { executeGitHubGraphQL } from "../graphql.js";
import {
  githubBotListPullRequestReviewThreadsToolMetadata,
  githubBotListPullRequestReviewThreadsToolName
} from "../../../shared/github-bot-list-pull-request-review-threads-tool.js";

const DEFAULT_FIRST = 50;
const MAX_FIRST = 100;
const MAX_COMMENTS_PER_THREAD = 50;

export interface ListPullRequestReviewThreadsParams {
  repository: string;
  pullNumber: number;
  first?: number;
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
  if (p.first !== undefined) {
    if (typeof p.first !== "number" || !Number.isInteger(p.first) || p.first <= 0) {
      return { ok: false, error: "first must be a positive integer if provided" };
    }
    if (p.first > MAX_FIRST) {
      return { ok: false, error: `first must be at most ${MAX_FIRST}` };
    }
  }
  const validated: ListPullRequestReviewThreadsParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    first: p.first as number | undefined
  };
  return { ok: true, params: validated };
}

const LIST_REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $commentsFirst: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: $first) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          comments(first: $commentsFirst) {
            nodes {
              id
              databaseId
              url
              body
              author {
                login
              }
              createdAt
            }
          }
        }
      }
    }
  }
}`;

interface ListReviewThreadsGraphQLData {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          isOutdated: boolean;
          path: string;
          line: number | null;
          startLine: number | null;
          diffSide: string | null;
          comments: {
            nodes: Array<{
              id: string;
              databaseId: number | null;
              url: string;
              body: string;
              author: { login: string } | null;
              createdAt: string;
            }>;
          };
        }>;
      };
    } | null;
  } | null;
}

export const githubListPullRequestReviewThreadsToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotListPullRequestReviewThreadsToolName,
  metadata: githubBotListPullRequestReviewThreadsToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as ListPullRequestReviewThreadsParams;
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
    const validated = execution.params as ListPullRequestReviewThreadsParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const first = Math.min(validated.first ?? DEFAULT_FIRST, MAX_FIRST);

    const result = await executeGitHubGraphQL<ListReviewThreadsGraphQLData>(
      ctx,
      token,
      LIST_REVIEW_THREADS_QUERY,
      {
        owner,
        repo,
        number: validated.pullNumber,
        first,
        commentsFirst: MAX_COMMENTS_PER_THREAD
      }
    );

    if (!result.ok) {
      return { error: `Failed to list pull request review threads: ${result.error}` };
    }

    if (!result.data.repository?.pullRequest) {
      return {
        error: `Pull request #${validated.pullNumber} was not found in ${repository.fullName} or is not accessible to this GitHub App installation.`
      };
    }

    const threads = result.data.repository.pullRequest.reviewThreads.nodes.map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      path: thread.path,
      line: thread.line,
      startLine: thread.startLine,
      diffSide: thread.diffSide,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.id,
        url: comment.url,
        body: comment.body,
        author: comment.author?.login ?? null,
        createdAt: comment.createdAt
      }))
    }));

    ctx.logger.info(
      `Listed ${threads.length} review thread(s) on pull request #${validated.pullNumber} in ${repository.fullName}`
    );

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Listed review threads on pull request #${validated.pullNumber} in ${repository.fullName}`,
      entityType: "pull_request_review_threads",
      entityId: String(validated.pullNumber),
      metadata: {
        repository: repository.fullName,
        prNumber: validated.pullNumber,
        count: threads.length,
        agentId: runCtx.agentId
      }
    });

    return {
      content: `Found ${threads.length} review thread(s) on PR #${validated.pullNumber}`,
      data: {
        threads
      }
    };
  }
};
