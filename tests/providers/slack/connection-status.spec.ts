import { describe, expect, it, vi } from "vitest";
import { runSlackConnectionCheck, contributeSlackConnectionStatusAction } from "../../../src/providers/slack/connection-status.js";
import type { ResolvedAgentIdentity } from "../../../src/core/agent-identity.js";
import type { SlackAgentIdentity, SlackSecretRef } from "../../../src/providers/slack/config.js";

const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";
const BOT_TOKEN_REF = {
  type: "secret_ref",
  secretId: "00000000-0000-4000-8000-000000000010",
  version: "latest",
} as const satisfies SlackSecretRef;

function fakeIdentity(agentId = "agent-1"): ResolvedAgentIdentity<SlackAgentIdentity> {
  return {
    agentId,
    identity: {
      label: "Bot",
      teamId: "T123",
      appId: "A123",
      botUserId: "U123",
    },
  };
}

function slackConfig(agentId = "agent-1", overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    identities: {
      [agentId]: {
        slack: {
          label: "Bot",
          teamId: "T123",
          appId: "A123",
          botUserId: "U123",
          credentials: {
            botToken: BOT_TOKEN_REF,
            signingSecret: {
              type: "secret_ref",
              secretId: "00000000-0000-4000-8000-000000000011",
              version: "latest",
            },
          },
          ...overrides,
        },
      },
    },
  };
}

describe("runSlackConnectionCheck", () => {
  it("reports ok on a healthy auth.test round trip (never returns the token)", async () => {
    const resolveSecret = vi.fn(async () => "xoxb-test-token");
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, team_id: "T123", user_id: "U123", bot_id: "B123" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome).toEqual({ ok: true });
    expect(result.checkedAt).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("xoxb-test-token");
  });

  it("categorizes a rejected/invalid credential as auth_test_failed with guidance", async () => {
    const resolveSecret = vi.fn(async () => "xoxb-revoked-token");
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: "invalid_auth" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.category).toBe("auth_test_failed");
    }
    expect(result.nextStep).toContain("Reinstall");
  });

  it("categorizes a workspace mismatch distinctly from an auth failure", async () => {
    const resolveSecret = vi.fn(async () => "xoxb-wrong-workspace-token");
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, team_id: "T999", user_id: "U123", bot_id: "B123" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.category).toBe("workspace_mismatch");
    }
  });

  it("categorizes a user-token (missing bot_id) as identity_mismatch", async () => {
    const resolveSecret = vi.fn(async () => "xoxp-user-token");
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: true, team_id: "T123", user_id: "U123" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.category).toBe("identity_mismatch");
    }
  });

  it("categorizes a missing secret reference as credential_missing", async () => {
    const resolveSecret = vi.fn(async () => "unused");
    const fetchImpl = vi.fn();
    const configWithoutCreds: Record<string, unknown> = {
      identities: { "agent-1": { slack: { label: "Bot", teamId: "T123", appId: "A123", botUserId: "U123" } } },
    };

    const result = await runSlackConnectionCheck(fakeIdentity(), configWithoutCreds, COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.category).toBe("credential_missing");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("categorizes a secret-resolution rejection (e.g. deleted/revoked secret) as credential_resolution_failed", async () => {
    const resolveSecret = vi.fn(async () => {
      throw new Error("secret not found");
    });
    const fetchImpl = vi.fn();

    const result = await runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.category).toBe("credential_resolution_failed");
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // Review finding (DRO-1161): the old catch-all fallback reported *any*
  // uncategorized error -- including a transport/DNS throw out of
  // verifySlackToken's fetch -- as credential_resolution_failed, telling the
  // operator to fix a secret reference during a plain network outage.
  it("categorizes a transport/DNS failure reaching Slack as network_failed, not credential_resolution_failed", async () => {
    const resolveSecret = vi.fn(async () => "xoxb-test-token");
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND slack.com");
    });

    const result = await runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(result.outcome.category).toBe("network_failed");
      expect(result.outcome.reason).not.toMatch(/secret reference/i);
      expect(result.outcome.reason).not.toContain("ENOTFOUND");
    }
    expect(result.nextStep).toMatch(/connectivity problem, not a credential problem/i);
    expect(resolveSecret).toHaveBeenCalledOnce();
  });

  it("categorizes a genuinely unexpected non-network, non-credential error as unknown", async () => {
    const resolveSecret = vi.fn(async () => "xoxb-test-token");
    const fetchImpl = vi.fn();
    // A malformed config entry makes resolveSlackBotToken throw before either
    // tagged stage, exercising the (now reachable) `unknown` category.
    const brokenConfig = { identities: { "agent-1": { slack: { label: "Bot" } } } };

    const result = await runSlackConnectionCheck(fakeIdentity(), brokenConfig, COMPANY_ID, resolveSecret, fetchImpl);

    expect(result.outcome.ok).toBe(false);
    if (!result.outcome.ok) {
      expect(["unknown", "credential_missing"]).toContain(result.outcome.category);
    }
    expect(result.nextStep).toBeTruthy();
  });

  it("categorizes a hung Slack API call as a bounded timeout, not an indefinite hang", async () => {
    const resolveSecret = vi.fn(async () => "xoxb-test-token");
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {
      // Never resolves -- the bounded check must still return within the
      // module's timeout instead of hanging the settings action forever.
    }));

    vi.useFakeTimers();
    try {
      const resultPromise = runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;
      expect(result.outcome.ok).toBe(false);
      if (!result.outcome.ok) {
        expect(result.outcome.category).toBe("timeout");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("never leaks the resolved token into the reason/nextStep strings on failure", async () => {
    const resolveSecret = vi.fn(async () => "xoxb-super-secret-token");
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: "xoxb-super-secret-token-in-error" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await runSlackConnectionCheck(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, fetchImpl);
    expect(JSON.stringify(result)).not.toContain("xoxb-super-secret-token");
  });
});

describe("contributeSlackConnectionStatusAction", () => {
  function fakeCtx(overrides?: Partial<{
    configGet: () => Promise<Record<string, unknown>>;
    resolve: () => Promise<string>;
    fetchImpl: () => Promise<Response>;
  }>) {
    const registered = new Map<string, (params: Record<string, unknown>, context: { companyId: string | null; actor: { type: string } }) => Promise<unknown>>();
    const ctx = {
      actions: {
        register: (key: string, handler: (params: Record<string, unknown>, context: { companyId: string | null; actor: { type: string } }) => Promise<unknown>) => {
          registered.set(key, handler);
        },
      },
      config: {
        get: overrides?.configGet ?? (async () => slackConfig()),
      },
      secrets: {
        resolve: overrides?.resolve ?? (async () => "xoxb-test-token"),
      },
      http: {
        fetch: overrides?.fetchImpl ?? (async () => new Response(
          JSON.stringify({ ok: true, team_id: "T123", user_id: "U123", bot_id: "B123" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )),
      },
    };
    return { ctx, registered };
  }

  it("registers check-slack-connection and never returns a token/secrets field", async () => {
    const { ctx, registered } = fakeCtx();
    contributeSlackConnectionStatusAction(ctx as never);
    const handler = registered.get("check-slack-connection");
    expect(handler).toBeTruthy();

    const result = (await handler!({ agentId: "agent-1" }, { companyId: COMPANY_ID, actor: { type: "user" } })) as Record<string, unknown>;
    expect(result.outcome).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toMatch(/token|xoxb/i);
  });

  it("rejects a request missing agentId before touching config/secrets", async () => {
    const { ctx, registered } = fakeCtx();
    contributeSlackConnectionStatusAction(ctx as never);
    const handler = registered.get("check-slack-connection")!;
    await expect(handler({}, { companyId: COMPANY_ID, actor: { type: "user" } })).rejects.toThrow(/agentId/);
  });

  it("rejects a request without a host-authorized companyId", async () => {
    const { ctx, registered } = fakeCtx();
    contributeSlackConnectionStatusAction(ctx as never);
    const handler = registered.get("check-slack-connection")!;
    await expect(handler({ agentId: "agent-1" }, { companyId: null, actor: { type: "user" } })).rejects.toThrow(/companyId/);
  });

  it("rejects a non-human actor before touching config/secrets/http (DRO-1161 auth gap)", async () => {
    const { ctx, registered } = fakeCtx();
    contributeSlackConnectionStatusAction(ctx as never);
    const handler = registered.get("check-slack-connection")!;
    await expect(handler({ agentId: "agent-1" }, { companyId: COMPANY_ID, actor: { type: "agent" } })).rejects.toThrow(
      "This settings action requires a human user actor.",
    );
  });

  it("reports credential_missing when the agent has no Slack identity configured", async () => {
    const { ctx, registered } = fakeCtx({ configGet: async () => ({ identities: {} }) });
    contributeSlackConnectionStatusAction(ctx as never);
    const handler = registered.get("check-slack-connection")!;
    const result = (await handler({ agentId: "agent-1" }, { companyId: COMPANY_ID, actor: { type: "user" } })) as { outcome: { ok: boolean; category?: string } };
    expect(result.outcome.ok).toBe(false);
    expect(result.outcome.category).toBe("credential_missing");
  });
});
