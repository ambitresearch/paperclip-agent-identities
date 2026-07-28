import { describe, it, expect, vi } from "vitest";
import { githubReplyToReviewThreadToolSpec } from "../../../src/providers/github/tools/reply-to-review-thread.js";
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

describe("githubReplyToReviewThreadToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubReplyToReviewThreadToolSpec.validateParams({ reviewThreadId: "PRRT_1", body: "lgtm" })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing reviewThreadId", () => {
    expect(
      githubReplyToReviewThreadToolSpec.validateParams({ repository: "acme/widgets", body: "lgtm" })
    ).toEqual({ ok: false, error: "reviewThreadId is required" });
  });

  it("rejects a missing/blank body", () => {
    expect(
      githubReplyToReviewThreadToolSpec.validateParams({ repository: "acme/widgets", reviewThreadId: "PRRT_1" })
    ).toEqual({ ok: false, error: "body is required" });

    expect(
      githubReplyToReviewThreadToolSpec.validateParams({ repository: "acme/widgets", reviewThreadId: "PRRT_1", body: "   " })
    ).toEqual({ ok: false, error: "body is required" });
  });

  it("rejects a non-string llmModel", () => {
    expect(
      githubReplyToReviewThreadToolSpec.validateParams({
        repository: "acme/widgets", reviewThreadId: "PRRT_1", body: "lgtm", llmModel: 5
      })
    ).toEqual({ ok: false, error: "llmModel must be a string if provided" });
  });

  it("accepts a full valid param set", () => {
    const res = githubReplyToReviewThreadToolSpec.validateParams({
      repository: "acme/widgets", reviewThreadId: "PRRT_1", body: "Looks good", llmModel: "claude", paperclipIssueId: "DRO-1"
    });
    expect(res.ok).toBe(true);
  });
});

describe("githubReplyToReviewThreadToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubReplyToReviewThreadToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", reviewThreadId: "PRRT_1", body: "hi" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository before any credential is resolved", async () => {
    const res = await githubReplyToReviewThreadToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", reviewThreadId: "PRRT_1", body: "hi" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubReplyToReviewThreadToolSpec.perform", () => {
  function execution(token: string | null, ctx: unknown, params?: Record<string, unknown>): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: params ?? { repository: "acme/widgets", reviewThreadId: "PRRT_1", body: "Looks good" },
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never
    };
  }

  it("returns an internal error when the token is null", async () => {
    const result = await githubReplyToReviewThreadToolSpec.perform(execution(null, buildCtx(vi.fn())));
    expect(result).toEqual({ error: "Internal error: missing resolved credential." });
  });

  it("appends the AI-authorship footer and posts the reply via GraphQL", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return {
        ok: true,
        json: async () => ({
          data: {
            addPullRequestReviewThreadReply: {
              comment: { id: "PRRC_1", databaseId: 42, url: "https://github.com/acme/widgets/pull/1#discussion_r42", body: "Looks good\n\n---\nfooter" }
            }
          }
        })
      };
    }) as unknown as typeof fetch;
    const activityLog = vi.fn();

    const result = await githubReplyToReviewThreadToolSpec.perform(execution("tok", buildCtx(fetchImpl, activityLog)));

    expect((capturedBody as { variables: { body: string } }).variables.body).toContain("Looks good");
    expect((capturedBody as { variables: { body: string } }).variables.body).toContain("AI agent via Paperclip");
    expect(result).toEqual({
      content: "Replied to review thread: https://github.com/acme/widgets/pull/1#discussion_r42",
      data: { id: "PRRC_1", url: "https://github.com/acme/widgets/pull/1#discussion_r42" }
    });
    expect(activityLog).toHaveBeenCalledTimes(1);
  });

  it("includes the model line in the footer when llmModel is provided", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(init!.body as string);
      return {
        ok: true,
        json: async () => ({
          data: {
            addPullRequestReviewThreadReply: {
              comment: { id: "PRRC_1", databaseId: 42, url: "https://example.com", body: "x" }
            }
          }
        })
      };
    }) as unknown as typeof fetch;

    await githubReplyToReviewThreadToolSpec.perform(
      execution("tok", buildCtx(fetchImpl), { repository: "acme/widgets", reviewThreadId: "PRRT_1", body: "Looks good", llmModel: "claude-5" })
    );

    expect((capturedBody as { variables: { body: string } }).variables.body).toContain("Model: claude-5");
  });

  it("surfaces a GraphQL error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: "Could not resolve to a node with the global id" }] })
    })) as unknown as typeof fetch;

    const result = await githubReplyToReviewThreadToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({ error: "Failed to reply to review thread: Could not resolve to a node with the global id" });
  });

  it("surfaces a network failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await githubReplyToReviewThreadToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Failed to reply to review thread: GitHub GraphQL request failed before a response was received: network down"
    });
  });
});
