import { describe, it, expect, vi } from "vitest";
import { githubGetIssueInteractionSummaryToolSpec } from "../../../src/providers/github/tools/get-issue-interaction-summary.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";
import type { ResourceReference } from "../../../src/core/resource-reference.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

interface FakeComment {
  id: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date | string;
  deletedAt?: Date | null;
}

function buildCtx(opts: {
  issue?: { id: string; title: string; status: string } | null;
  comments?: FakeComment[];
  listCommentsError?: Error;
  activityLog?: ReturnType<typeof vi.fn>;
}) {
  const activityLog = opts.activityLog ?? vi.fn();
  return {
    issues: {
      get: vi.fn(async () => (opts.issue === undefined ? { id: "iss-1", title: "Sample issue", status: "in_progress" } : opts.issue)),
      listComments: vi.fn(async () => {
        if (opts.listCommentsError) throw opts.listCommentsError;
        return opts.comments ?? [];
      })
    },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog }
  } as never;
}

function execution(params: Record<string, unknown>, ctx: unknown): ProviderToolExecution<GitHubAgentIdentity, ResourceReference> {
  return {
    token: null,
    identity,
    resourceRef: null,
    params,
    ctx: ctx as never,
    runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
  };
}

describe("githubGetIssueInteractionSummaryToolSpec.validateParams", () => {
  it("rejects a missing issueId", () => {
    expect(githubGetIssueInteractionSummaryToolSpec.validateParams({})).toEqual({
      ok: false,
      error: "issueId is required"
    });
  });

  it("rejects an invalid from date", () => {
    expect(
      githubGetIssueInteractionSummaryToolSpec.validateParams({ issueId: "iss-1", from: "not-a-date" })
    ).toEqual({ ok: false, error: "from must be a valid ISO 8601 date string" });
  });

  it("rejects an invalid to date", () => {
    expect(
      githubGetIssueInteractionSummaryToolSpec.validateParams({ issueId: "iss-1", to: "not-a-date" })
    ).toEqual({ ok: false, error: "to must be a valid ISO 8601 date string" });
  });

  it("rejects to <= from", () => {
    expect(
      githubGetIssueInteractionSummaryToolSpec.validateParams({
        issueId: "iss-1",
        from: "2026-01-10T00:00:00.000Z",
        to: "2026-01-10T00:00:00.000Z"
      })
    ).toEqual({ ok: false, error: "to must be strictly after from" });
  });

  it("rejects a window longer than 30 days", () => {
    expect(
      githubGetIssueInteractionSummaryToolSpec.validateParams({
        issueId: "iss-1",
        from: "2026-01-01T00:00:00.000Z",
        to: "2026-02-05T00:00:00.000Z"
      })
    ).toEqual({ ok: false, error: "the [from, to) window must not exceed 30 days" });
  });

  it("accepts a valid 30-day window", () => {
    const res = githubGetIssueInteractionSummaryToolSpec.validateParams({
      issueId: "iss-1",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T00:00:00.000Z"
    });
    expect(res.ok).toBe(true);
  });

  it("accepts params with no window at all", () => {
    expect(githubGetIssueInteractionSummaryToolSpec.validateParams({ issueId: "iss-1" }).ok).toBe(true);
  });
});

describe("githubGetIssueInteractionSummaryToolSpec.perform", () => {
  it("returns an error when the issue does not exist", async () => {
    const ctx = buildCtx({ issue: null });
    const result = (await githubGetIssueInteractionSummaryToolSpec.perform(
      execution({ issueId: "missing" }, ctx)
    )) as { error: string };
    expect(result.error).toBe("Paperclip issue missing was not found in this company.");
  });

  it("surfaces a listComments failure without throwing", async () => {
    const ctx = buildCtx({ listCommentsError: new Error("db down") });
    const result = (await githubGetIssueInteractionSummaryToolSpec.perform(
      execution({ issueId: "iss-1" }, ctx)
    )) as { error: string };
    expect(result.error).toBe("Failed to read Paperclip issue comments.");
  });

  it("filters comments to the [from, to) window, excluding the to boundary", async () => {
    const comments: FakeComment[] = [
      { id: "c1", authorAgentId: "a1", authorUserId: null, body: "before window", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c2", authorAgentId: "a1", authorUserId: null, body: "in window", createdAt: "2026-01-10T00:00:00.000Z" },
      { id: "c3", authorAgentId: "a1", authorUserId: null, body: "on the to boundary", createdAt: "2026-01-20T00:00:00.000Z" },
      { id: "c4", authorAgentId: "a1", authorUserId: null, body: "after window", createdAt: "2026-01-25T00:00:00.000Z" }
    ];
    const ctx = buildCtx({ comments });
    const result = (await githubGetIssueInteractionSummaryToolSpec.perform(
      execution({ issueId: "iss-1", from: "2026-01-05T00:00:00.000Z", to: "2026-01-20T00:00:00.000Z" }, ctx)
    )) as { data: { interactionCount: number; interactions: Array<{ id: string }> } };

    expect(result.data.interactionCount).toBe(1);
    expect(result.data.interactions.map((i) => i.id)).toEqual(["c2"]);
  });

  it("excludes soft-deleted comments", async () => {
    const comments: FakeComment[] = [
      { id: "c1", authorAgentId: "a1", authorUserId: null, body: "live", createdAt: "2026-01-10T00:00:00.000Z" },
      { id: "c2", authorAgentId: "a1", authorUserId: null, body: "deleted", createdAt: "2026-01-11T00:00:00.000Z", deletedAt: new Date("2026-01-12T00:00:00.000Z") }
    ];
    const ctx = buildCtx({ comments });
    const result = (await githubGetIssueInteractionSummaryToolSpec.perform(
      execution({ issueId: "iss-1" }, ctx)
    )) as { data: { interactionCount: number; interactions: Array<{ id: string }> } };
    expect(result.data.interactions.map((i) => i.id)).toEqual(["c1"]);
  });

  it("orders interactions deterministically: ascending createdAt, tie-broken by id", async () => {
    const comments: FakeComment[] = [
      { id: "c2", authorAgentId: "a1", authorUserId: null, body: "second by id", createdAt: "2026-01-10T00:00:00.000Z" },
      { id: "c1", authorAgentId: "a1", authorUserId: null, body: "first by id, same time", createdAt: "2026-01-10T00:00:00.000Z" },
      { id: "c0", authorAgentId: "a1", authorUserId: null, body: "earliest", createdAt: "2026-01-05T00:00:00.000Z" }
    ];
    const ctx = buildCtx({ comments });
    const result = (await githubGetIssueInteractionSummaryToolSpec.perform(
      execution({ issueId: "iss-1" }, ctx)
    )) as { data: { interactions: Array<{ id: string }> } };
    expect(result.data.interactions.map((i) => i.id)).toEqual(["c0", "c1", "c2"]);
  });

  it("redacts common secret shapes and truncates long bodies", async () => {
    const longBody = "x".repeat(400);
    const comments: FakeComment[] = [
      {
        id: "c1",
        authorAgentId: "a1",
        authorUserId: null,
        body: `token ghp_${"a".repeat(36)} and Bearer abcdefghij1234567890 in ${longBody}`,
        createdAt: "2026-01-10T00:00:00.000Z"
      }
    ];
    const ctx = buildCtx({ comments });
    const result = (await githubGetIssueInteractionSummaryToolSpec.perform(
      execution({ issueId: "iss-1" }, ctx)
    )) as { data: { interactions: Array<{ bodyPreview: string }> } };
    const preview = result.data.interactions[0].bodyPreview;
    expect(preview).not.toContain("ghp_");
    expect(preview).toContain("[REDACTED]");
    expect(preview.length).toBeLessThanOrEqual(281);
  });

  it("counts distinct agent and user authors and logs activity without leaking bodies", async () => {
    const comments: FakeComment[] = [
      { id: "c1", authorAgentId: "a1", authorUserId: null, body: "hi", createdAt: "2026-01-10T00:00:00.000Z" },
      { id: "c2", authorAgentId: "a1", authorUserId: null, body: "hi again", createdAt: "2026-01-11T00:00:00.000Z" },
      { id: "c3", authorAgentId: null, authorUserId: "u1", body: "human reply", createdAt: "2026-01-12T00:00:00.000Z" }
    ];
    const activityLog = vi.fn(async () => {});
    const ctx = buildCtx({ comments, activityLog });
    const result = (await githubGetIssueInteractionSummaryToolSpec.perform(
      execution({ issueId: "iss-1" }, ctx)
    )) as { data: { distinctAgentAuthors: number; distinctUserAuthors: number } };
    expect(result.data.distinctAgentAuthors).toBe(1);
    expect(result.data.distinctUserAuthors).toBe(1);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ entityId: string; metadata: { agentId: string } }]>)[0][0];
    expect(loggedCall.entityId).toBe("iss-1");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});
