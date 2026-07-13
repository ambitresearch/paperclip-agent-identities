import { describe, it, expect, vi } from "vitest";
import {
  slackReactToolSpec,
  normalizeSlackEmojiName,
  normalizeSlackMessageTimestamp
} from "../../../src/providers/slack/tools/react.js";
import type {
  ProviderToolExecution
} from "../../../src/core/provider-contract.js";
import type { SlackAgentIdentity } from "../../../src/providers/slack/config.js";
import type { SlackChannelRef } from "../../../src/providers/slack/channel-ref.js";

const FAKE_TOKEN = "xoxb-fake-test-token";

const identity = {
  agentId: "agent-1",
  identity: {
    label: "Bot",
    teamId: "T0123456789",
    appId: "A0123456789",
    botUserId: "U0123456789"
  } as SlackAgentIdentity
};

function channelRef(): SlackChannelRef {
  return { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789" };
}

function buildCtx(fetchImpl: typeof fetch, activityLog = vi.fn(async () => {})) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog }
  } as never;
}

const runCtx = { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never;

describe("normalizeSlackEmojiName", () => {
  it("accepts a bare short-name", () => {
    expect(normalizeSlackEmojiName("white_check_mark")).toBe("white_check_mark");
  });

  it("accepts a colon-wrapped short-name and strips colons", () => {
    expect(normalizeSlackEmojiName(":white_check_mark:")).toBe("white_check_mark");
  });

  it("rejects malformed emoji names", () => {
    expect(normalizeSlackEmojiName("")).toBeNull();
    expect(normalizeSlackEmojiName("   ")).toBeNull();
    expect(normalizeSlackEmojiName(":only-open")).toBeNull();
    expect(normalizeSlackEmojiName("has space")).toBeNull();
    expect(normalizeSlackEmojiName("HAS_CAPS")).toBeNull();
    expect(normalizeSlackEmojiName("::")).toBeNull();
    expect(normalizeSlackEmojiName(null)).toBeNull();
    expect(normalizeSlackEmojiName(42)).toBeNull();
  });
});

describe("normalizeSlackMessageTimestamp", () => {
  it("accepts a well-formed Slack timestamp", () => {
    expect(normalizeSlackMessageTimestamp("1719000000.123456")).toBe("1719000000.123456");
  });

  it("rejects malformed timestamps", () => {
    expect(normalizeSlackMessageTimestamp("1719000000")).toBeNull();
    expect(normalizeSlackMessageTimestamp("1719000000.12")).toBeNull();
    expect(normalizeSlackMessageTimestamp("abc.123456")).toBeNull();
    expect(normalizeSlackMessageTimestamp("")).toBeNull();
    expect(normalizeSlackMessageTimestamp(undefined)).toBeNull();
  });
});

describe("slackReactToolSpec.validateParams", () => {
  it("accepts a full valid param set", () => {
    const res = slackReactToolSpec.validateParams({
      channel: "C0123456789",
      timestamp: "1719000000.123456",
      emoji: "white_check_mark"
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a malformed emoji", () => {
    const res = slackReactToolSpec.validateParams({
      channel: "C0123456789",
      timestamp: "1719000000.123456",
      emoji: "not a valid emoji!"
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a malformed timestamp", () => {
    const res = slackReactToolSpec.validateParams({
      channel: "C0123456789",
      timestamp: "not-a-timestamp",
      emoji: "white_check_mark"
    });
    expect(res.ok).toBe(false);
  });

  it("rejects unsupported extra payload fields", () => {
    const res = slackReactToolSpec.validateParams({
      channel: "C0123456789",
      timestamp: "1719000000.123456",
      emoji: "white_check_mark",
      extraField: "nope"
    });
    expect(res).toEqual({ ok: false, error: "Unsupported parameter(s): extraField" });
  });

  it("rejects a missing channel", () => {
    const res = slackReactToolSpec.validateParams({
      timestamp: "1719000000.123456",
      emoji: "white_check_mark"
    });
    expect(res.ok).toBe(false);
  });
});

describe("slackReactToolSpec.resolveResourceRef", () => {
  it("resolves a valid channel/timestamp/teamId into a SlackChannelRef", async () => {
    const res = await slackReactToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", timestamp: "1719000000.123456", emoji: "white_check_mark" },
      identity,
      ctx: { activity: { log: vi.fn(async () => {}) } } as never,
      runCtx
    });
    expect(res).toEqual({
      ok: true,
      ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789", threadTs: "1719000000.123456" }
    });
  });

  it("fails closed on a wrong-team reference before credentials are resolved", async () => {
    const res = await slackReactToolSpec.resolveResourceRef!({
      params: {
        channel: "C0123456789",
        timestamp: "1719000000.123456",
        emoji: "white_check_mark",
        teamId: "T9999999999"
      },
      identity,
      ctx: { activity: { log: vi.fn(async () => {}) } } as never,
      runCtx
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("workspace mismatch");
    }
  });
});

describe("slackReactToolSpec.perform", () => {
  function execution(token: string | null): ProviderToolExecution<SlackAgentIdentity, SlackChannelRef> {
    return {
      token,
      identity,
      resourceRef: channelRef(),
      params: { channel: "C0123456789", timestamp: "1719000000.123456", emoji: "white_check_mark" },
      ctx: buildCtx(vi.fn() as never),
      runCtx
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await slackReactToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("adds a reaction successfully", async () => {
    const fetchImpl = vi.fn(async (url: string, opts: RequestInit) => {
      expect(url).toBe("https://slack.com/api/reactions.add");
      expect((opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackReactToolSpec.perform(exec)) as { content: string; data: { emoji: string } };
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.data.emoji).toBe("white_check_mark");
    expect(result.content).toContain("white_check_mark");
  });

  it("surfaces a Slack API error code such as already_reacted", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "already_reacted" }), { status: 200 }));
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackReactToolSpec.perform(exec)) as { error: string; code: string };
    expect(result.code).toBe("already_reacted");
    expect(result.error).toContain("already_reacted");
  });

  it("surfaces missing_scope errors", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "missing_scope" }), { status: 200 }));
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackReactToolSpec.perform(exec)) as { error: string; code: string };
    expect(result.code).toBe("missing_scope");
  });

  it("never leaks the raw bot token in the returned success or error payloads", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "invalid_name" }), { status: 200 }));
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = await slackReactToolSpec.perform(exec);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("never interpolates the raw bot token into a network-failure log message", async () => {
    const errorLog = vi.fn();
    // perform() never reads `token` when building this log line — a
    // network-layer error message here is whatever `fetch` itself threw,
    // never anything perform() constructs from the token.
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const exec = execution(FAKE_TOKEN);
    const ctx = buildCtx(fetchImpl as never);
    (ctx as { logger: { error: unknown } }).logger = { info: vi.fn(), error: errorLog };
    (exec as { ctx: unknown }).ctx = ctx;
    const result = await slackReactToolSpec.perform(exec);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(errorLog.mock.calls.some((call) => String(call[0]).includes(FAKE_TOKEN))).toBe(false);
  });

  it("pipeline-level redaction (redactSecrets) scrubs the token even if it leaked into an error payload", async () => {
    const { redactSecrets } = await import("../../../src/lib/redaction.js");
    const leaked = { error: `Slack call failed with token ${FAKE_TOKEN}` };
    const redacted = redactSecrets(leaked, [FAKE_TOKEN]);
    expect(JSON.stringify(redacted)).not.toContain(FAKE_TOKEN);
  });
});
