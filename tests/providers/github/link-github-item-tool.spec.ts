import { describe, it, expect, vi } from "vitest";
import { githubLinkGithubItemToolSpec } from "../../../src/providers/github/tools/link-github-item.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";
import type { ResourceReference } from "../../../src/core/resource-reference.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

function buildCtx(
  stateStore: Record<string, unknown> = {},
  activityLog = vi.fn()
) {
  return {
    state: {
      get: vi.fn(async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        const storeKey = `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? "default"}:${key.stateKey}`;
        return storeKey in stateStore ? stateStore[storeKey] : null;
      }),
      set: vi.fn(async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
        const storeKey = `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? "default"}:${key.stateKey}`;
        stateStore[storeKey] = value;
      })
    },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog }
  } as never;
}

describe("githubLinkGithubItemToolSpec.validateParams", () => {
  it("rejects a missing paperclipIssueId", () => {
    expect(
      githubLinkGithubItemToolSpec.validateParams({ githubUrl: "https://github.com/acme/widgets/issues/7" })
    ).toEqual({ ok: false, error: "paperclipIssueId is required" });
  });

  it("rejects a missing githubUrl", () => {
    expect(
      githubLinkGithubItemToolSpec.validateParams({ paperclipIssueId: "iss-1" })
    ).toEqual({ ok: false, error: "githubUrl is required" });
  });

  it("rejects a non-URL githubUrl", () => {
    expect(
      githubLinkGithubItemToolSpec.validateParams({ paperclipIssueId: "iss-1", githubUrl: "not-a-url" })
    ).toEqual({ ok: false, error: "githubUrl must be a valid absolute URL" });
  });

  it("rejects a non-github.com URL", () => {
    expect(
      githubLinkGithubItemToolSpec.validateParams({ paperclipIssueId: "iss-1", githubUrl: "https://example.com/acme/widgets/issues/7" })
    ).toEqual({ ok: false, error: "githubUrl must be a github.com URL" });
  });

  it("accepts valid params", () => {
    const res = githubLinkGithubItemToolSpec.validateParams({
      paperclipIssueId: "iss-1",
      githubUrl: "https://github.com/acme/widgets/issues/7",
      note: "tracking follow-up"
    });
    expect(res.ok).toBe(true);
  });
});

describe("githubLinkGithubItemToolSpec.perform", () => {
  function execution(params: Record<string, unknown>, ctx: unknown): ProviderToolExecution<GitHubAgentIdentity, ResourceReference> {
    return {
      token: null,
      tokenSource: null,
      identity,
      resourceRef: null,
      params,
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("persists a new link scoped to the Paperclip issue, independent of any project-repo mapping", async () => {
    const store: Record<string, unknown> = {};
    const ctx = buildCtx(store);
    const result = (await githubLinkGithubItemToolSpec.perform(
      execution({ paperclipIssueId: "iss-1", githubUrl: "https://github.com/acme/widgets/issues/7", note: "root cause" }, ctx)
    )) as { data: { totalLinks: number; githubUrl: string } };

    expect(result.data.totalLinks).toBe(1);
    expect(result.data.githubUrl).toBe("https://github.com/acme/widgets/issues/7");
    expect(store["issue:iss-1:github-links:links"]).toEqual([
      {
        githubUrl: "https://github.com/acme/widgets/issues/7",
        note: "root cause",
        linkedByAgentId: "agent-1",
        linkedAt: expect.any(String)
      }
    ]);
  });

  it("updates an existing link rather than duplicating it", async () => {
    const store: Record<string, unknown> = {
      "issue:iss-1:github-links:links": [
        { githubUrl: "https://github.com/acme/widgets/issues/7", note: "old note", linkedByAgentId: "agent-0", linkedAt: "2020-01-01T00:00:00.000Z" }
      ]
    };
    const ctx = buildCtx(store);
    const result = (await githubLinkGithubItemToolSpec.perform(
      execution({ paperclipIssueId: "iss-1", githubUrl: "https://github.com/acme/widgets/issues/7", note: "new note" }, ctx)
    )) as { data: { totalLinks: number } };

    expect(result.data.totalLinks).toBe(1);
    const links = store["issue:iss-1:github-links:links"] as Array<{ note: string }>;
    expect(links).toHaveLength(1);
    expect(links[0].note).toBe("new note");
  });

  it("appends a second distinct link for the same issue", async () => {
    const store: Record<string, unknown> = {};
    const ctx = buildCtx(store);
    await githubLinkGithubItemToolSpec.perform(
      execution({ paperclipIssueId: "iss-1", githubUrl: "https://github.com/acme/widgets/issues/7" }, ctx)
    );
    const result = (await githubLinkGithubItemToolSpec.perform(
      execution({ paperclipIssueId: "iss-1", githubUrl: "https://github.com/acme/widgets/pull/9" }, ctx)
    )) as { data: { totalLinks: number } };
    expect(result.data.totalLinks).toBe(2);
  });

  it("logs activity metadata for the link", async () => {
    const store: Record<string, unknown> = {};
    const activityLog = vi.fn(async () => {});
    const ctx = buildCtx(store, activityLog);
    await githubLinkGithubItemToolSpec.perform(
      execution({ paperclipIssueId: "iss-1", githubUrl: "https://github.com/acme/widgets/issues/7" }, ctx)
    );
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ entityId: string; metadata: { agentId: string } }]>)[0][0];
    expect(loggedCall.entityId).toBe("iss-1");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });

  it("surfaces a storage error without throwing", async () => {
    const ctx = {
      state: {
        get: vi.fn(async () => {
          throw new Error("storage down");
        }),
        set: vi.fn()
      },
      logger: { info: vi.fn(), error: vi.fn() },
      activity: { log: vi.fn() }
    } as never;
    const result = (await githubLinkGithubItemToolSpec.perform(
      execution({ paperclipIssueId: "iss-1", githubUrl: "https://github.com/acme/widgets/issues/7" }, ctx)
    )) as { error: string };
    expect(result.error).toBe("Failed to read existing GitHub links before linking.");
  });
});
