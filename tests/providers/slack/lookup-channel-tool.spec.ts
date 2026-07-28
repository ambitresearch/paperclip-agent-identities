import { describe, it, expect, vi } from "vitest";
import { slackLookupChannelToolSpec } from "../../../src/providers/slack/tools/lookup-channel.js";
import { createProviderTool } from "../../../src/core/tool-pipeline.js";
import type { IdentityProvider } from "../../../src/core/provider-contract.js";
import type { SlackAgentIdentity } from "../../../src/providers/slack/config.js";
import type { ResourceReference } from "../../../src/core/resource-reference.js";

const identity: SlackAgentIdentity = {
  label: "Bot",
  teamId: "T0123456789",
  appId: "A0123456789",
  botUserId: "U0123456789",
  defaultChannel: "C0123456789"
};

const otherCompanyIdentity: SlackAgentIdentity = {
  label: "Other Co Bot",
  teamId: "T9999999999",
  appId: "A9999999999",
  botUserId: "U9999999999",
  defaultChannel: "C9999999999"
};

const runCtx = { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never;

function buildCtx(fetchImpl: ReturnType<typeof vi.fn>) {
  return {
    http: { fetch: fetchImpl },
    activity: { log: vi.fn(async () => {}) },
    logger: { error: vi.fn(), info: vi.fn() },
    secrets: { resolve: vi.fn(async () => "test-bot-token") }
  } as never;
}

function jsonResponse(
  ok: boolean,
  body: Record<string, unknown>,
  status = ok ? 200 : 400,
  headers?: Record<string, string>
) {
  return {
    ok,
    status,
    headers: { get: (name: string) => headers?.[name] ?? null },
    json: async () => body
  } as Response;
}

function conversationsListResponse(
  channels: Array<Record<string, unknown>>,
  nextCursor?: string
) {
  return jsonResponse(true, {
    ok: true,
    channels,
    response_metadata: nextCursor ? { next_cursor: nextCursor } : { next_cursor: "" }
  });
}

function buildExecution(fetchImpl: ReturnType<typeof vi.fn>, params: Record<string, unknown>) {
  const ctx = buildCtx(fetchImpl);
  return {
    token: "test-bot-token",
    identity: { agentId: "agent-1", identity },
    resourceRef: null,
    params,
    ctx,
    runCtx
  } as never;
}

describe("slackLookupChannelToolSpec.validateParams", () => {
  it("accepts a valid channel name", () => {
    const result = slackLookupChannelToolSpec.validateParams({ channel: "general" });
    expect(result).toEqual({ ok: true, params: { channel: "general" } });
  });

  it("accepts a #-prefixed channel name", () => {
    const result = slackLookupChannelToolSpec.validateParams({ channel: "#general" });
    expect(result.ok).toBe(true);
  });

  it("accepts an already-resolved conversation ID", () => {
    const result = slackLookupChannelToolSpec.validateParams({ channel: "C0123456789" });
    expect(result).toEqual({ ok: true, params: { channel: "C0123456789" } });
  });

  it("rejects an empty channel", () => {
    const result = slackLookupChannelToolSpec.validateParams({ channel: "" });
    expect(result.ok).toBe(false);
  });

  it("rejects a channel over 100 characters", () => {
    const result = slackLookupChannelToolSpec.validateParams({ channel: "a".repeat(101) });
    expect(result.ok).toBe(false);
  });

  it("rejects a URL disguised as a channel reference", () => {
    for (const url of [
      "https://acme.slack.com/archives/C0123456789",
      "https://slack.com/app_redirect?channel=C0123456789",
      "slack://channel?id=C0123456789"
    ]) {
      const result = slackLookupChannelToolSpec.validateParams({ channel: url });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects arbitrary free text / wildcard-like input", () => {
    for (const text of ["please give me #general", "*", "general OR random", "a b c", "UPPERCASE"]) {
      const result = slackLookupChannelToolSpec.validateParams({ channel: text });
      expect(result.ok).toBe(false);
    }
  });

  it("rejects unknown fields", () => {
    const result = slackLookupChannelToolSpec.validateParams({ channel: "general", extra: 1 });
    expect(result).toEqual({ ok: false, error: "Unknown parameter(s): extra" });
  });

  it("rejects a malformed teamId", () => {
    const result = slackLookupChannelToolSpec.validateParams({ channel: "general", teamId: "not-a-team" });
    expect(result.ok).toBe(false);
  });

  it("accepts a valid teamId", () => {
    const result = slackLookupChannelToolSpec.validateParams({
      channel: "general",
      teamId: "T0123456789"
    });
    expect(result).toEqual({ ok: true, params: { channel: "general", teamId: "T0123456789" } });
  });

  it("rejects non-object params", () => {
    expect(slackLookupChannelToolSpec.validateParams("nope").ok).toBe(false);
  });
});

describe("slackLookupChannelToolSpec — cross-workspace isolation", () => {
  it("denies a teamId mismatch in resolveResourceRef, before any credential/API call", async () => {
    const fetchImpl = vi.fn();
    const ctx = buildCtx(fetchImpl);
    const input = {
      params: { channel: "general", teamId: "T9999999999" },
      identity: { agentId: "agent-1", identity },
      ctx,
      runCtx
    } as never;
    const resolution = await slackLookupChannelToolSpec.resolveResourceRef!(input);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.error).toMatch(/workspace mismatch/i);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("succeeds resolveResourceRef when teamId matches the identity's own team", async () => {
    const ctx = buildCtx(vi.fn());
    const input = {
      params: { channel: "general", teamId: "T0123456789" },
      identity: { agentId: "agent-1", identity },
      ctx,
      runCtx
    } as never;
    const resolution = await slackLookupChannelToolSpec.resolveResourceRef!(input);
    expect(resolution).toEqual({ ok: true, ref: null });
  });
});

describe("slackLookupChannelToolSpec.perform — ID passthrough", () => {
  it("returns an already-resolved ID without an extra API call", async () => {
    const fetchImpl = vi.fn();
    const execution = buildExecution(fetchImpl, { channel: "C0123456789" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as {
      data: { channelId: string; resolvedFrom: string };
    };
    expect(result.data.channelId).toBe("C0123456789");
    expect(result.data.resolvedFrom).toBe("id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("slackLookupChannelToolSpec.perform — name resolution", () => {
  it("resolves an exact single match to its canonical ID", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("conversations.list");
      return conversationsListResponse([
        { id: "C0000000001", name: "general", is_archived: false }
      ]);
    });
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as {
      data: { channelId: string; resolvedFrom: string };
    };
    expect(result.data.channelId).toBe("C0000000001");
    expect(result.data.resolvedFrom).toBe("name");
  });

  it("paginates across cursor pages to find the match", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return conversationsListResponse(
          [{ id: "C0000000002", name: "random", is_archived: false }],
          "cursor-2"
        );
      }
      return conversationsListResponse([{ id: "C0000000003", name: "general", is_archived: false }]);
    });
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as {
      data: { channelId: string };
    };
    expect(result.data.channelId).toBe("C0000000003");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns an actionable error with zero matches, without crashing", async () => {
    const fetchImpl = vi.fn(async () => conversationsListResponse([]));
    const execution = buildExecution(fetchImpl, { channel: "nonexistent-channel" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toMatch(/no accessible slack channel/i);
  });

  it("returns an explicit ambiguity error naming conflicting IDs on duplicate names", async () => {
    const fetchImpl = vi.fn(async () =>
      conversationsListResponse([
        { id: "C0000000004", name: "eng", is_archived: false },
        { id: "C0000000005", name: "eng", is_archived: false }
      ])
    );
    const execution = buildExecution(fetchImpl, { channel: "eng" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toContain("C0000000004");
    expect(result.error).toContain("C0000000005");
    expect(result.error.toLowerCase()).toContain("multiple");
  });

  it("bounds the number of conflicting IDs reported for a name shared by many channels", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `C0${String(i + 1).padStart(9, "0")}`,
      name: "eng",
      is_archived: false
    }));
    const fetchImpl = vi.fn(async () => conversationsListResponse(many));
    const execution = buildExecution(fetchImpl, { channel: "eng" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    const idMatches = result.error.match(/C0\d{9}/g) ?? [];
    expect(idMatches.length).toBeLessThanOrEqual(20);
    expect(result.error).toMatch(/more, not shown/i);
  });

  it("excludes archived channels from matches and does not auto-join", async () => {
    const fetchImpl = vi.fn(async (_url: string) =>
      conversationsListResponse([{ id: "C0000000006", name: "old-project", is_archived: true }])
    );
    const execution = buildExecution(fetchImpl, { channel: "old-project" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toMatch(/no accessible slack channel/i);
    // Never calls conversations.join.
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toContain("conversations.join");
    }
  });

  it("bounds pagination and does not loop forever on an endless cursor chain, failing closed on truncation", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      return conversationsListResponse(
        [{ id: `C0${String(calls).padStart(9, "0")}`, name: "no-match", is_archived: false }],
        `cursor-${calls}`
      );
    });
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    // The result set was truncated (a cursor still remained) before a full
    // scan could establish uniqueness — this must fail closed with an
    // actionable error, not silently report "no match" or an unverified
    // single match.
    expect(result.error).toMatch(/could not conclusively resolve/i);
    // Bounded: does not call fetch an unbounded number of times.
    expect(calls).toBeLessThanOrEqual(25);
  });

  it("fails closed on truncation even when exactly one match was seen so far (unseen later page could duplicate it)", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return conversationsListResponse(
          [{ id: "C0000000009", name: "general", is_archived: false }],
          "cursor-1"
        );
      }
      return conversationsListResponse(
        [{ id: `C0${String(calls).padStart(9, "0")}`, name: "no-match", is_archived: false }],
        `cursor-${calls}`
      );
    });
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toMatch(/could not conclusively resolve/i);
  });
});

describe("slackLookupChannelToolSpec.perform — rate limiting", () => {
  it("retries a bounded number of times on HTTP 429, then succeeds", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(false, {}, 429);
      }
      return conversationsListResponse([{ id: "C0000000007", name: "general", is_archived: false }]);
    });
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as {
      data: { channelId: string };
    };
    expect(result.data.channelId).toBe("C0000000007");
    expect(call).toBe(2);
  });

  it("fails closed with an actionable error after repeated rate limiting, never crashing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, {}, 429));
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toMatch(/rate limit/i);
  });

  it("also handles Slack's {ok:false, error:'rate_limited'} shape", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, { ok: false, error: "rate_limited" }));
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toMatch(/rate limit/i);
  });

  it("honors the Slack Retry-After header instead of the fixed linear backoff", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // 5s Retry-After is far longer than RATE_LIMIT_BACKOFF_MS * 1 (500ms).
          return jsonResponse(false, {}, 429, { "Retry-After": "5" });
        }
        return conversationsListResponse([
          { id: "C0000000009", name: "general", is_archived: false }
        ]);
      });
      const execution = buildExecution(fetchImpl, { channel: "general" });
      const pending = slackLookupChannelToolSpec.perform(execution) as Promise<{
        data: { channelId: string };
      }>;

      // The fixed backoff alone would have already fired the retry by now.
      await vi.advanceTimersByTimeAsync(600);
      expect(call).toBe(1);

      // Advancing to the full Retry-After window releases the retry.
      await vi.advanceTimersByTimeAsync(4_500);
      expect((await pending).data.channelId).toBe("C0000000009");
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps an extreme Retry-After value to the bounded maximum delay", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          // One hour: must be clamped to MAX_RATE_LIMIT_DELAY_MS (30s), so a
          // hostile or extreme header cannot stall the tool indefinitely.
          return jsonResponse(false, {}, 429, { "Retry-After": "3600" });
        }
        return conversationsListResponse([
          { id: "C0000000010", name: "general", is_archived: false }
        ]);
      });
      const execution = buildExecution(fetchImpl, { channel: "general" });
      const pending = slackLookupChannelToolSpec.perform(execution) as Promise<{
        data: { channelId: string };
      }>;

      await vi.advanceTimersByTimeAsync(30_000);
      expect((await pending).data.channelId).toBe("C0000000010");
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the fixed backoff when Retry-After is absent or malformed", async () => {
    vi.useFakeTimers();
    try {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return jsonResponse(false, {}, 429, { "Retry-After": "not-a-number" });
        }
        return conversationsListResponse([
          { id: "C0000000011", name: "general", is_archived: false }
        ]);
      });
      const execution = buildExecution(fetchImpl, { channel: "general" });
      const pending = slackLookupChannelToolSpec.perform(execution) as Promise<{
        data: { channelId: string };
      }>;

      await vi.advanceTimersByTimeAsync(600);
      expect((await pending).data.channelId).toBe("C0000000011");
      expect(call).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("slackLookupChannelToolSpec.perform — API/network failure handling", () => {
  it("fails closed on a Slack API error without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, { ok: false, error: "invalid_auth" }));
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toContain("invalid_auth");
    expect(result.error).not.toContain("test-bot-token");
  });

  it("never leaks the token when the fetch throws (network failure)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down: Authorization: Bearer test-bot-token");
    });
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).not.toContain("test-bot-token");
    expect(result.error).not.toContain("Authorization");
  });

  it("does not throw/crash on a network failure — returns a plain error object", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const execution = buildExecution(fetchImpl, { channel: "general" });
    await expect(slackLookupChannelToolSpec.perform(execution)).resolves.toEqual(
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});

describe("slackLookupChannelToolSpec — credential/redaction posture", () => {
  it("requires a credential (requiresCredential is not explicitly false)", () => {
    expect(slackLookupChannelToolSpec.requiresCredential).not.toBe(false);
  });

  it("returns an internal error rather than crashing when token is null", async () => {
    const execution = {
      token: null,
      identity: { agentId: "agent-1", identity },
      resourceRef: null,
      params: { channel: "general" },
      ctx: buildCtx(vi.fn()),
      runCtx
    } as never;
    const result = (await slackLookupChannelToolSpec.perform(execution)) as { error: string };
    expect(result.error).toMatch(/missing resolved credential/i);
  });

  it("never includes the bot token anywhere in a successful result", async () => {
    const fetchImpl = vi.fn(async () =>
      conversationsListResponse([{ id: "C0000000008", name: "general", is_archived: false }])
    );
    const execution = buildExecution(fetchImpl, { channel: "general" });
    const result = await slackLookupChannelToolSpec.perform(execution);
    expect(JSON.stringify(result)).not.toContain("test-bot-token");
  });

  it("never logs the token via ctx.activity.log or ctx.logger.error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, { ok: false, error: "invalid_auth" }));
    const ctx = buildCtx(fetchImpl);
    const execution = {
      token: "test-bot-token",
      identity: { agentId: "agent-1", identity },
      resourceRef: null,
      params: { channel: "general" },
      ctx,
      runCtx
    } as never;
    await slackLookupChannelToolSpec.perform(execution);
    const activityLogCalls = (ctx as { activity: { log: ReturnType<typeof vi.fn> } }).activity.log.mock.calls;
    const loggerErrorCalls = (ctx as { logger: { error: ReturnType<typeof vi.fn> } }).logger.error.mock.calls;
    for (const call of [...activityLogCalls, ...loggerErrorCalls]) {
      expect(JSON.stringify(call)).not.toContain("test-bot-token");
    }
  });
});

describe("slackLookupChannelToolSpec — end-to-end through the shared pipeline (company/agent/workspace isolation)", () => {
  function buildProvider(
    resolveCredential: () => Promise<{ token: string; secrets: string[] }>
  ) {
    return {
      id: "slack",
      definition: { id: "slack", name: "Slack", status: "coming-soon", description: "" },
      validateConfig: () => ({}),
      projectPluginConfig: () => ({}),
      resolveCredential,
      tools: [],
      manifestTools: []
    } as unknown as IdentityProvider<SlackAgentIdentity, ResourceReference>;
  }

  it("full pipeline resolves a name to a canonical ID scoped to the calling agent's own installation", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(true, {
        ok: true,
        channels: [{ id: "C0000000010", name: "general", is_archived: false }],
        response_metadata: { next_cursor: "" }
      })
    );
    const ctx = buildCtx(fetchImpl);
    const resolveCredential = vi.fn(async () => ({ token: "test-bot-token", secrets: ["test-bot-token"] }));
    const provider = buildProvider(resolveCredential);

    const registered = createProviderTool(provider, slackLookupChannelToolSpec, ctx, {
      resolveIdentity: async () => ({ agentId: "agent-1", identity }),
      redactSecrets: (value, secrets) => {
        let serialized = JSON.stringify(value);
        for (const secret of secrets) {
          serialized = serialized.split(secret).join("[REDACTED]");
        }
        return JSON.parse(serialized);
      }
    });

    const result = (await registered.handler({ channel: "general" }, runCtx)) as {
      data: { channelId: string };
    };
    expect(result.data.channelId).toBe("C0000000010");
    expect(JSON.stringify(result)).not.toContain("test-bot-token");
  });

  it("full pipeline denies a cross-installation teamId before any credential resolution (no cross-company/agent lookup)", async () => {
    const fetchImpl = vi.fn();
    const ctx = buildCtx(fetchImpl);
    const resolveCredential = vi.fn(async () => ({ token: "test-bot-token", secrets: ["test-bot-token"] }));
    const provider = buildProvider(resolveCredential);

    const registered = createProviderTool(provider, slackLookupChannelToolSpec, ctx, {
      // This agent's identity is bound to team T0123456789 only.
      resolveIdentity: async () => ({ agentId: "agent-1", identity }),
      redactSecrets: (value) => value
    });

    // Caller attempts to reach into a different installation's workspace
    // (otherCompanyIdentity's teamId) via the optional teamId param.
    const result = (await registered.handler(
      { channel: "general", teamId: otherCompanyIdentity.teamId },
      runCtx
    )) as { error: string };

    expect(result.error).toMatch(/workspace mismatch/i);
    // Credential resolution (and therefore any Slack API visibility) never
    // happens for a denied cross-installation reference.
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("full pipeline scopes conversations.list visibility to the resolved identity's own credential — a second agent's identity/credential never leaks into the first agent's lookup", async () => {
    const fetchImplAgentOne = vi.fn(async () =>
      jsonResponse(true, {
        ok: true,
        channels: [{ id: "C0000000011", name: "general", is_archived: false }],
        response_metadata: { next_cursor: "" }
      })
    );
    const ctxAgentOne = buildCtx(fetchImplAgentOne);
    const providerAgentOne = buildProvider(async () => ({ token: "agent-one-token", secrets: ["agent-one-token"] }));
    const registeredAgentOne = createProviderTool(providerAgentOne, slackLookupChannelToolSpec, ctxAgentOne, {
      resolveIdentity: async () => ({ agentId: "agent-1", identity }),
      redactSecrets: (value, secrets) => {
        let serialized = JSON.stringify(value);
        for (const secret of secrets) serialized = serialized.split(secret).join("[REDACTED]");
        return JSON.parse(serialized);
      }
    });

    const fetchImplAgentTwo = vi.fn(async () =>
      jsonResponse(true, {
        ok: true,
        channels: [{ id: "C0000000099", name: "general", is_archived: false }],
        response_metadata: { next_cursor: "" }
      })
    );
    const ctxAgentTwo = buildCtx(fetchImplAgentTwo);
    const providerAgentTwo = buildProvider(async () => ({ token: "agent-two-token", secrets: ["agent-two-token"] }));
    const registeredAgentTwo = createProviderTool(providerAgentTwo, slackLookupChannelToolSpec, ctxAgentTwo, {
      resolveIdentity: async () => ({ agentId: "agent-2", identity: otherCompanyIdentity }),
      redactSecrets: (value, secrets) => {
        let serialized = JSON.stringify(value);
        for (const secret of secrets) serialized = serialized.split(secret).join("[REDACTED]");
        return JSON.parse(serialized);
      }
    });

    const resultOne = (await registeredAgentOne.handler({ channel: "general" }, runCtx)) as {
      data: { channelId: string };
    };
    const resultTwo = (await registeredAgentTwo.handler(
      { channel: "general" },
      { agentId: "agent-2", companyId: "co-2", projectId: "p-1", runId: "r-1" } as never
    )) as { data: { channelId: string } };

    // Each agent's lookup only ever sees its own installation's conversations.list.
    expect(resultOne.data.channelId).toBe("C0000000011");
    expect(resultTwo.data.channelId).toBe("C0000000099");
    expect(fetchImplAgentOne).toHaveBeenCalledTimes(1);
    expect(fetchImplAgentTwo).toHaveBeenCalledTimes(1);
  });
});
