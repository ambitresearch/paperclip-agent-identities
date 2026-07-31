import { describe, it, expect, vi } from "vitest";
import { githubUnresolveReviewThreadToolSpec } from "../../../src/providers/github/tools/unresolve-review-thread.js";
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

describe("githubUnresolveReviewThreadToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(githubUnresolveReviewThreadToolSpec.validateParams({ reviewThreadId: "PRRT_1" }))
      .toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing reviewThreadId", () => {
    expect(githubUnresolveReviewThreadToolSpec.validateParams({ repository: "acme/widgets" }))
      .toEqual({ ok: false, error: "reviewThreadId is required" });
  });

  it("accepts a valid param set", () => {
    const res = githubUnresolveReviewThreadToolSpec.validateParams({ repository: "acme/widgets", reviewThreadId: "PRRT_1" });
    expect(res.ok).toBe(true);
  });
});

describe("githubUnresolveReviewThreadToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubUnresolveReviewThreadToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", reviewThreadId: "PRRT_1" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository before any credential is resolved", async () => {
    const res = await githubUnresolveReviewThreadToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", reviewThreadId: "PRRT_1" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubUnresolveReviewThreadToolSpec.perform", () => {
  function execution(token: string | null, ctx: unknown): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      tokenSource: "github-app",
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", reviewThreadId: "PRRT_1" },
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never
    };
  }

  it("returns an internal error when the token is null", async () => {
    const result = await githubUnresolveReviewThreadToolSpec.perform(execution(null, buildCtx(vi.fn())));
    expect(result).toEqual({ error: "Internal error: missing resolved credential." });
  });

  it("unresolves the thread on a successful GraphQL response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init.body));
      if (typeof body.query === "string" && body.query.includes("node(id: $threadId)")) {
        return {
          ok: true,
          json: async () => ({
            data: { node: { repository: { owner: { login: "acme" }, name: "widgets" } } }
          })
        };
      }
      return {
        ok: true,
        json: async () => ({
          data: { unresolveReviewThread: { thread: { id: "PRRT_1", isResolved: false } } }
        })
      };
    }) as unknown as typeof fetch;
    const activityLog = vi.fn();

    const result = await githubUnresolveReviewThreadToolSpec.perform(execution("tok", buildCtx(fetchImpl, activityLog)));

    expect(result).toEqual({
      content: "Unresolved review thread PRRT_1.",
      data: { id: "PRRT_1", isResolved: false }
    });
    expect(activityLog).toHaveBeenCalledTimes(1);
  });

  it("surfaces a GraphQL error", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      const body = JSON.parse(String(init.body));
      if (typeof body.query === "string" && body.query.includes("node(id: $threadId)")) {
        return {
          ok: true,
          json: async () => ({
            data: { node: { repository: { owner: { login: "acme" }, name: "widgets" } } }
          })
        };
      }
      return {
        ok: true,
        json: async () => ({ errors: [{ message: "Resource not accessible by integration" }] })
      };
    }) as unknown as typeof fetch;

    const result = await githubUnresolveReviewThreadToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({ error: "Failed to unresolve review thread: Resource not accessible by integration" });
  });

  it("rejects a thread that belongs to a different repository", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { node: { repository: { owner: { login: "other-org" }, name: "other-repo" } } }
      })
    })) as unknown as typeof fetch;

    const result = await githubUnresolveReviewThreadToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Review thread belongs to 'other-org/other-repo', not the requested repository 'acme/widgets'."
    });
  });
});
