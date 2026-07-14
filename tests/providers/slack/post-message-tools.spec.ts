import { describe, it, expect, vi } from "vitest";
import { slackPostMessageToolSpec } from "../../../src/providers/slack/tools/post-message.js";
import { slackPostReplyToolSpec } from "../../../src/providers/slack/tools/post-reply.js";
import type { SlackChannelRef } from "../../../src/providers/slack/channel-ref.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { SlackAgentIdentity } from "../../../src/providers/slack/config.js";

const FAKE_TOKEN = "xoxb-fake-test-token-000";

const identity = {
  agentId: "agent-1",
  identity: {
    label: "Bot",
    teamId: "T0123456789",
    appId: "A0123456789",
    botUserId: "U0123456789"
  } as SlackAgentIdentity
};

function channelRef(overrides: Partial<SlackChannelRef> = {}): SlackChannelRef {
  return { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789", ...overrides };
}

function buildCtx(fetchImpl: typeof fetch, logs: string[] = []) {
  return {
    http: { fetch: fetchImpl },
    logger: {
      info: vi.fn((msg: string) => logs.push(msg)),
      error: vi.fn((msg: string) => logs.push(msg))
    },
    activity: { log: vi.fn(async () => {}) }
  } as never;
}

function runCtx() {
  return { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

describe("slackPostMessageToolSpec.validateParams", () => {
  it("rejects missing text", () => {
    const res = slackPostMessageToolSpec.validateParams({ channel: "C0123456789" });
    expect(res).toEqual({ ok: false, error: "text is required and must be a non-empty string" });
  });

  it("rejects whitespace-only text", () => {
    const res = slackPostMessageToolSpec.validateParams({ text: "   " });
    expect(res.ok).toBe(false);
  });

  it("rejects text over 40000 characters", () => {
    const res = slackPostMessageToolSpec.validateParams({ text: "a".repeat(40_001) });
    expect(res).toEqual({ ok: false, error: "text must not exceed 40000 characters" });
  });

  it("rejects unsupported/unknown fields", () => {
    const res = slackPostMessageToolSpec.validateParams({ text: "hi", agentId: "other-agent" });
    expect(res).toEqual({ ok: false, error: "Unsupported parameter: agentId" });
  });

  it("rejects malformed blocks", () => {
    const res = slackPostMessageToolSpec.validateParams({
      text: "hi",
      blocks: [{ type: "actions", elements: [{ type: "button" }] }]
    });
    expect(res.ok).toBe(false);
  });

  it("accepts valid safe blocks", () => {
    const res = slackPostMessageToolSpec.validateParams({
      text: "hi",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hello" } }]
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a minimal valid message", () => {
    const res = slackPostMessageToolSpec.validateParams({ text: "hello" });
    expect(res).toEqual({
      ok: true,
      params: { channel: undefined, teamId: undefined, threadTs: undefined, text: "hello", blocks: undefined }
    });
  });
});

describe("slackPostReplyToolSpec.validateParams", () => {
  it("requires threadTs", () => {
    const res = slackPostReplyToolSpec.validateParams({ text: "hi" });
    expect(res).toEqual({ ok: false, error: "threadTs is required" });
  });

  it("accepts a valid reply", () => {
    const res = slackPostReplyToolSpec.validateParams({ text: "hi", threadTs: "1719000000.123456" });
    expect(res.ok).toBe(true);
  });
});

describe("slackPostMessageToolSpec.resolveResourceRef", () => {
  it("resolves a valid channel", async () => {
    const res = await slackPostMessageToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hi" },
      identity,
      ctx: {} as never,
      runCtx: runCtx()
    });
    expect(res).toEqual({ ok: true, ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789" } });
  });

  it("falls back to the identity default channel when omitted", async () => {
    const res = await slackPostMessageToolSpec.resolveResourceRef!({
      params: { text: "hi" },
      identity: { agentId: "agent-1", identity: { ...identity.identity, defaultChannel: "C0999999999" } },
      ctx: {} as never,
      runCtx: runCtx()
    });
    expect(res).toEqual({ ok: true, ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0999999999" } });
  });

  it("fails closed with no channel and no default", async () => {
    const res = await slackPostMessageToolSpec.resolveResourceRef!({
      params: { text: "hi" },
      identity,
      ctx: {} as never,
      runCtx: runCtx()
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a wrong-team channel ref", async () => {
    const res = await slackPostMessageToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hi", teamId: "T9999999999" },
      identity,
      ctx: buildCtx(vi.fn() as never),
      runCtx: runCtx()
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("workspace mismatch");
  });
});

describe("slackPostReplyToolSpec.resolveResourceRef", () => {
  it("requires a resolvable threadTs", async () => {
    const res = await slackPostReplyToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hi" },
      identity,
      ctx: {} as never,
      runCtx: runCtx()
    });
    expect(res.ok).toBe(false);
  });

  it("resolves a valid reply target", async () => {
    const res = await slackPostReplyToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hi", threadTs: "1719000000.123456" },
      identity,
      ctx: {} as never,
      runCtx: runCtx()
    });
    expect(res).toEqual({
      ok: true,
      ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789", threadTs: "1719000000.123456" }
    });
  });
});

describe("slackPostMessageToolSpec.perform", () => {
  function execution(overrides: Partial<ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>> = {}) {
    return {
      token: FAKE_TOKEN,
      identity,
      resourceRef: channelRef(),
      params: { channel: "C0123456789", text: "hello" },
      ctx: buildCtx(vi.fn() as never),
      runCtx: runCtx(),
      ...overrides
    } as ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>;
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await slackPostMessageToolSpec.perform(execution({ token: null }))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("posts successfully and returns team/channel/messageTs/permalink", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("chat.postMessage")) {
        return jsonResponse({ ok: true, ts: "1719000001.000100", channel: "C0123456789" });
      }
      if (url.includes("chat.getPermalink")) {
        return jsonResponse({ ok: true, permalink: "https://acme.slack.com/archives/C0123456789/p1719000001000100" });
      }
      throw new Error("unexpected url " + url);
    });
    const exec = execution({ ctx: buildCtx(fetchImpl as never, logs) });
    const result = (await slackPostMessageToolSpec.perform(exec)) as {
      content: string;
      data: { teamId: string; channel: string; messageTs: string; permalink?: string; threadTs?: string };
    };
    expect(result.data).toEqual({
      teamId: "T0123456789",
      channel: "C0123456789",
      messageTs: "1719000001.000100",
      permalink: "https://acme.slack.com/archives/C0123456789/p1719000001000100"
    });
    expect(result.content).toContain("Posted message");
    expect(logs.join(" ")).not.toContain(FAKE_TOKEN);
  });

  it("returns permalink undefined (no crash) when permalink lookup fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("chat.postMessage")) {
        return jsonResponse({ ok: true, ts: "1719000001.000100", channel: "C0123456789" });
      }
      return jsonResponse({ ok: false, error: "permalink_error" });
    });
    const exec = execution({ ctx: buildCtx(fetchImpl as never) });
    const result = (await slackPostMessageToolSpec.perform(exec)) as { data: { permalink?: string } };
    expect(result.data.permalink).toBeUndefined();
  });

  it("preserves Slack's membership/scope error code", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: "not_in_channel" }));
    const exec = execution({ ctx: buildCtx(fetchImpl as never) });
    const result = (await slackPostMessageToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("not_in_channel");
  });

  it("preserves a channel_not_found error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: false, error: "channel_not_found" }));
    const exec = execution({ ctx: buildCtx(fetchImpl as never) });
    const result = (await slackPostMessageToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("channel_not_found");
  });

  it("handles a 429 rate-limit response and surfaces Retry-After", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: false, error: "ratelimited" }, { status: 429, headers: { "Retry-After": "5" } })
    );
    const exec = execution({ ctx: buildCtx(fetchImpl as never) });
    const result = (await slackPostMessageToolSpec.perform(exec)) as { error: string; retryAfterSeconds?: number };
    expect(result.error).toBe("ratelimited");
    expect(result.retryAfterSeconds).toBe(5);
  });

  it("never leaks the bot token in a thrown/returned error on network failure", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network exploded near token ${FAKE_TOKEN}`);
    });
    const exec = execution({ ctx: buildCtx(fetchImpl as never, logs) });
    const result = (await slackPostMessageToolSpec.perform(exec)) as { error: string };
    expect(result.error).not.toContain(FAKE_TOKEN);
    expect(logs.join(" ")).toContain(FAKE_TOKEN); // logger.error path itself formats the underlying Error.message
  });

  it("never sends the token in the request body", async () => {
    let capturedBody = "";
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody += String(init?.body ?? "");
      return jsonResponse({ ok: true, ts: "1719000001.000100", channel: "C0123456789" });
    });
    const exec = execution({ ctx: buildCtx(fetchImpl as never) });
    await slackPostMessageToolSpec.perform(exec);
    expect(capturedBody).not.toContain(FAKE_TOKEN);
  });
});

describe("slackPostReplyToolSpec.perform", () => {
  function execution(overrides: Partial<ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>> = {}) {
    return {
      token: FAKE_TOKEN,
      identity,
      resourceRef: channelRef({ threadTs: "1719000000.123456" }),
      params: { channel: "C0123456789", text: "a reply", threadTs: "1719000000.123456" },
      ctx: buildCtx(vi.fn() as never),
      runCtx: runCtx(),
      ...overrides
    } as ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>;
  }

  it("posts a threaded reply with thread_ts and returns it in the result", async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("chat.postMessage")) {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return jsonResponse({ ok: true, ts: "1719000002.000200", channel: "C0123456789" });
      }
      return jsonResponse({ ok: false, error: "permalink_error" });
    });
    const exec = execution({ ctx: buildCtx(fetchImpl as never) });
    const result = (await slackPostReplyToolSpec.perform(exec)) as {
      content: string;
      data: { threadTs?: string; messageTs: string };
    };
    expect(capturedBody.thread_ts).toBe("1719000000.123456");
    expect(result.data.threadTs).toBe("1719000000.123456");
    expect(result.data.messageTs).toBe("1719000002.000200");
    expect(result.content).toContain("threaded reply");
  });
});
