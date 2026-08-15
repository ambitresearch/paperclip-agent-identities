import { describe, it, expect, vi } from "vitest";
import { githubListPullRequestReviewThreadsToolSpec } from "../../../src/providers/github/tools/list-pull-request-review-threads.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

function repoRef(): GitHubRepoRef {
  return { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" };
}

function buildCtx(fetchImpl: typeof fetch, activityLog = vi.fn()) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog }
  } as never;
}

describe("githubListPullRequestReviewThreadsToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(githubListPullRequestReviewThreadsToolSpec.validateParams({ pullNumber: 1 }))
      .toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid pullNumber", () => {
    expect(githubListPullRequestReviewThreadsToolSpec.validateParams({ repository: "acme/widgets" }))
      .toEqual({ ok: false, error: "pullNumber must be a positive integer" });

    expect(githubListPullRequestReviewThreadsToolSpec.validateParams({ repository: "acme/widgets", pullNumber: -1 }))
      .toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("rejects a non-integer first", () => {
    expect(githubListPullRequestReviewThreadsToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, first: 1.5 }))
      .toEqual({ ok: false, error: "first must be a positive integer if provided" });
  });

  it("rejects first above the max", () => {
    expect(githubListPullRequestReviewThreadsToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, first: 200 }))
      .toEqual({ ok: false, error: "first must be at most 100" });
  });

  it("accepts a valid param set", () => {
    const res = githubListPullRequestReviewThreadsToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7, first: 10 });
    expect(res.ok).toBe(true);
  });
});

describe("githubListPullRequestReviewThreadsToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubListPullRequestReviewThreadsToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository before any credential is resolved", async () => {
    const res = await githubListPullRequestReviewThreadsToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", pullNumber: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubListPullRequestReviewThreadsToolSpec.perform", () => {
  function execution(token: string | null, ctx: unknown, params?: Record<string, unknown>): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      tokenSource: "github-app",
      identity,
      resourceRef: repoRef(),
      params: params ?? { repository: "acme/widgets", pullNumber: 7 },
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never
    };
  }

  it("returns an internal error when the token is null", async () => {
    const result = await githubListPullRequestReviewThreadsToolSpec.perform(execution(null, buildCtx(vi.fn())));
    expect(result).toEqual({ error: "Internal error: missing resolved credential." });
  });

  it("returns threads with paths, comments, and resolution state on a successful GraphQL response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "PRRT_1",
                    isResolved: false,
                    isOutdated: false,
                    path: "src/index.ts",
                    line: 10,
                    startLine: null,
                    diffSide: "RIGHT",
                    comments: {
                      nodes: [
                        { id: "PRRC_1", databaseId: 1, url: "https://example.com/1", body: "Fix this", author: { login: "reviewer" }, createdAt: "2026-01-01T00:00:00Z" }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      })
    })) as unknown as typeof fetch;
    const activityLog = vi.fn();

    const result = await githubListPullRequestReviewThreadsToolSpec.perform(execution("tok", buildCtx(fetchImpl, activityLog)));

    expect(result).toEqual({
      content: "Found 1 review thread(s) on PR #7",
      data: {
        threads: [
          {
            id: "PRRT_1",
            isResolved: false,
            isOutdated: false,
            path: "src/index.ts",
            line: 10,
            startLine: null,
            diffSide: "RIGHT",
            comments: [
              { id: "PRRC_1", url: "https://example.com/1", body: "Fix this", author: "reviewer", createdAt: "2026-01-01T00:00:00Z" }
            ]
          }
        ]
      }
    });
    expect(activityLog).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the pull request is not found", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { repository: { pullRequest: null } } })
    })) as unknown as typeof fetch;

    const result = await githubListPullRequestReviewThreadsToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Pull request #7 was not found in acme/widgets or is not accessible to this GitHub App installation."
    });
  });

  it("surfaces a GraphQL error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: "Resource not accessible by integration" }] })
    })) as unknown as typeof fetch;

    const result = await githubListPullRequestReviewThreadsToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({ error: "Failed to list pull request review threads: Resource not accessible by integration" });
  });
});
