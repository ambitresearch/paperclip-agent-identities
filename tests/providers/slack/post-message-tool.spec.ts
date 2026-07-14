import { describe, it, expect, vi } from "vitest";
import { slackBotPostMessageToolSpec } from "../../../src/providers/slack/tools/post-message.js";
import {
  SLACK_MESSAGE_TEXT_MAX_LENGTH,
  SLACK_MESSAGE_BLOCKS_MAX_COUNT
} from "../../../src/shared/slack-bot-post-message-tool.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
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

function channelRef(overrides: Partial<SlackChannelRef> = {}): SlackChannelRef {
  return { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789", ...overrides };
}

function buildCtx(fetchImpl: typeof fetch, activityLog = vi.fn(async () => {})) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog }
  } as never;
}

const runCtx = { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never;

describe("slackBotPostMessageToolSpec.validateParams", () => {
  it("accepts a minimal valid param set", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello"
    });
    expect(res.ok).toBe(true);
  });

  it("accepts a full valid param set including blocks and threadTs", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "hi" } }],
      threadTs: "1719000000.123456",
      teamId: "T0123456789"
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a missing channel", () => {
    const res = slackBotPostMessageToolSpec.validateParams({ text: "hello" });
    expect(res.ok).toBe(false);
  });

  it("rejects a missing text", () => {
    const res = slackBotPostMessageToolSpec.validateParams({ channel: "C0123456789" });
    expect(res.ok).toBe(false);
  });

  it("rejects unsupported extra payload fields", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      extraField: "nope"
    });
    expect(res).toEqual({ ok: false, error: "Unsupported parameter(s): extraField" });
  });

  it("rejects text over the Slack length limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "a".repeat(SLACK_MESSAGE_TEXT_MAX_LENGTH + 1)
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a blocks array over the max count", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: Array.from({ length: SLACK_MESSAGE_BLOCKS_MAX_COUNT + 1 }, () => ({ type: "section" }))
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a non-array blocks value", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: "not-an-array"
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a non-string threadTs", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      threadTs: 12345
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a section block with text over Slack's 3000-character limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "a".repeat(3001) } }]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a section block with more than 10 fields", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [
        {
          type: "section",
          fields: Array.from({ length: 11 }, () => ({ type: "mrkdwn", text: "x" }))
        }
      ]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a section field over the 2000-character limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ type: "section", fields: [{ type: "mrkdwn", text: "a".repeat(2001) }] }]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a header block with text over the 150-character limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ type: "header", text: { type: "plain_text", text: "a".repeat(151) } }]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a context block with more than 10 elements", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [
        {
          type: "context",
          elements: Array.from({ length: 11 }, () => ({ type: "mrkdwn", text: "x" }))
        }
      ]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a context element text over the 2000-character limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ type: "context", elements: [{ type: "mrkdwn", text: "a".repeat(2001) }] }]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects an image block with image_url over Slack's 3000-character limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [
        {
          type: "image",
          image_url: `https://example.com/${"a".repeat(3000)}`,
          alt_text: "alt"
        }
      ]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects an image block with alt_text over the 2000-character limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ type: "image", image_url: "https://example.com/x.png", alt_text: "a".repeat(2001) }]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects an image title over the 150-character header limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [
        {
          type: "image",
          image_url: "https://example.com/x.png",
          alt_text: "alt",
          title: { type: "plain_text", text: "a".repeat(151) }
        }
      ]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a block_id over the 255-character limit", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ type: "divider", block_id: "a".repeat(256) }]
    });
    expect(res.ok).toBe(false);
  });

  it("accepts blocks at the exact boundary of each Slack limit", () => {
    const boundaryBlocks = [
      { type: "section", text: { type: "mrkdwn", text: "a".repeat(3000) } },
      { type: "section", fields: Array.from({ length: 10 }, () => ({ type: "mrkdwn", text: "a".repeat(2000) })) },
      { type: "header", text: { type: "plain_text", text: "a".repeat(150) } },
      { type: "context", elements: Array.from({ length: 10 }, () => ({ type: "mrkdwn", text: "a".repeat(2000) })) },
      { type: "image", image_url: "https://example.com/x.png", alt_text: "a".repeat(2000), block_id: "a".repeat(255) }
    ];
    for (const block of boundaryBlocks) {
      const res = slackBotPostMessageToolSpec.validateParams({
        channel: "C0123456789",
        text: "hello",
        blocks: [block]
      });
      expect(res.ok).toBe(true);
    }
  });
});

describe("slackBotPostMessageToolSpec.resolveResourceRef", () => {
  it("resolves a valid channel into a SlackChannelRef", async () => {
    const res = await slackBotPostMessageToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hello" },
      identity,
      ctx: { activity: { log: vi.fn(async () => {}) } } as never,
      runCtx
    });
    expect(res).toEqual({
      ok: true,
      ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789" }
    });
  });

  it("resolves threadTs into the ref for a threaded reply", async () => {
    const res = await slackBotPostMessageToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hello", threadTs: "1719000000.123456" },
      identity,
      ctx: { activity: { log: vi.fn(async () => {}) } } as never,
      runCtx
    });
    expect(res).toEqual({
      ok: true,
      ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789", threadTs: "1719000000.123456" }
    });
  });

  it("fails closed on a wrong-team reference before credentials are resolved (team/resource validation precedes token resolution)", async () => {
    const res = await slackBotPostMessageToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hello", teamId: "T9999999999" },
      identity,
      ctx: { activity: { log: vi.fn(async () => {}) } } as never,
      runCtx
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("workspace mismatch");
    }
  });

  it("fails closed on a malformed channel", async () => {
    const res = await slackBotPostMessageToolSpec.resolveResourceRef!({
      params: { channel: "not-a-channel", text: "hello" },
      identity,
      ctx: { activity: { log: vi.fn(async () => {}) } } as never,
      runCtx
    });
    expect(res.ok).toBe(false);
  });
});

describe("slackBotPostMessageToolSpec.perform", () => {
  function execution(
    token: string | null,
    params: Record<string, unknown> = { channel: "C0123456789", text: "hello" },
    ref: SlackChannelRef = channelRef()
  ): ProviderToolExecution<SlackAgentIdentity, SlackChannelRef> {
    return {
      token,
      identity,
      resourceRef: ref,
      params,
      ctx: buildCtx(vi.fn() as never),
      runCtx
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await slackBotPostMessageToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("posts a top-level message successfully and returns team/conversation/message metadata", async () => {
    const fetchImpl = vi.fn(async (url: string, opts: RequestInit) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/chat.postMessage")) {
        expect((opts.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_TOKEN}`);
        return new Response(
          JSON.stringify({ ok: true, ts: "1719000001.000100", channel: "C0123456789", team: "T0123456789" }),
          { status: 200 }
        );
      }
      if (parsedUrl.pathname.endsWith("/chat.getPermalink")) {
        return new Response(
          JSON.stringify({ ok: true, permalink: "https://acme.slack.com/archives/C0123456789/p1719000001000100" }),
          { status: 200 }
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackBotPostMessageToolSpec.perform(exec)) as {
      content: string;
      data: { team: string; conversation: string; messageTs: string; threadTs?: string; permalink?: string };
    };
    expect(result.data.team).toBe("T0123456789");
    expect(result.data.conversation).toBe("C0123456789");
    expect(result.data.messageTs).toBe("1719000001.000100");
    expect(result.data.threadTs).toBeUndefined();
    expect(result.data.permalink).toContain("https://acme.slack.com/");
  });

  it("posts a threaded reply successfully when threadTs is present on the resolved ref", async () => {
    const fetchImpl = vi.fn(async (url: string, opts: RequestInit) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/chat.postMessage")) {
        const body = JSON.parse((opts.body as string) ?? "{}");
        expect(body.thread_ts).toBe("1719000000.123456");
        return new Response(
          JSON.stringify({
            ok: true,
            ts: "1719000002.000200",
            channel: "C0123456789",
            message: { thread_ts: "1719000000.123456" }
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, permalink: "https://acme.slack.com/x" }), { status: 200 });
    });
    const ref = channelRef({ threadTs: "1719000000.123456" });
    const exec = execution(
      FAKE_TOKEN,
      { channel: "C0123456789", text: "reply text", threadTs: "1719000000.123456" },
      ref
    );
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackBotPostMessageToolSpec.perform(exec)) as {
      data: { messageTs: string; threadTs?: string };
    };
    expect(result.data.messageTs).toBe("1719000002.000200");
    expect(result.data.threadTs).toBe("1719000000.123456");
  });

  it("surfaces not_in_channel (membership failure) with an actionable error and code", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 })
    );
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackBotPostMessageToolSpec.perform(exec)) as { error: string; code: string };
    expect(result.code).toBe("not_in_channel");
    expect(result.error).toContain("not_in_channel");
  });

  it("surfaces missing_scope (scope failure) with an actionable error and code", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "missing_scope" }), { status: 200 })
    );
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackBotPostMessageToolSpec.perform(exec)) as { error: string; code: string };
    expect(result.code).toBe("missing_scope");
    expect(result.error).toContain("chat:write");
  });

  it("rejects a wrong-team channel before ever reaching perform (validated at resolveResourceRef)", async () => {
    const res = await slackBotPostMessageToolSpec.resolveResourceRef!({
      params: { channel: "C0123456789", text: "hi", teamId: "T9999999999" },
      identity,
      ctx: { activity: { log: vi.fn(async () => {}) } } as never,
      runCtx
    });
    expect(res.ok).toBe(false);
  });

  it("surfaces a rate-limit (429) response with an actionable, non-throwing error", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: { "Retry-After": "30" }
      })
    );
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackBotPostMessageToolSpec.perform(exec)) as { error: string; code: string; retryAfter?: string };
    expect(result.code).toBe("rate_limited");
    expect(result.retryAfter).toBe("30");
    expect(result.error).toContain("30");
  });

  it("rejects malformed content (oversized text) before perform is ever invoked", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "a".repeat(SLACK_MESSAGE_TEXT_MAX_LENGTH + 1)
    });
    expect(res.ok).toBe(false);
  });

  it("rejects malformed blocks content before perform is ever invoked", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{ circular: undefined as unknown }]
    });
    // Previously this passed (undefined-bearing values are JSON-serializable,
    // so they were silently dropped/nulled downstream). Now the block-shape
    // allowlist rejects any block whose `type` isn't a supported literal —
    // `{ circular: undefined }` has no `type` at all, so it is malformed.
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("not a supported block shape");
  });

  it("rejects an interactive/actions block (no callback path exists for it)", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Click" }, action_id: "a1" }]
      }]
    });
    expect(res.ok).toBe(false);
  });

  it("rejects a section block with an unsupported extra field", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [{
        type: "section",
        text: { type: "mrkdwn", text: "hi" },
        accessory: { type: "button", text: { type: "plain_text", text: "Click" }, action_id: "a1" }
      }]
    });
    expect(res.ok).toBe(false);
  });

  it("accepts each safe block type in the allowlist", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "hello",
      blocks: [
        { type: "divider" },
        { type: "section", text: { type: "mrkdwn", text: "hi" } },
        { type: "header", text: { type: "plain_text", text: "Title" } },
        { type: "context", elements: [{ type: "mrkdwn", text: "footer" }] },
        { type: "image", image_url: "https://example.com/i.png", alt_text: "an image" }
      ]
    });
    expect(res.ok).toBe(true);
  });

  it("rejects whitespace-only text", () => {
    const res = slackBotPostMessageToolSpec.validateParams({
      channel: "C0123456789",
      text: "   "
    });
    expect(res.ok).toBe(false);
  });

  it("never leaks the raw bot token in the returned success or error payloads", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), { status: 200 })
    );
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = await slackBotPostMessageToolSpec.perform(exec);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
  });

  it("never interpolates the raw bot token into a network-failure log message", async () => {
    const errorLog = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    const exec = execution(FAKE_TOKEN);
    const ctx = buildCtx(fetchImpl as never);
    (ctx as { logger: { info: unknown; error: unknown } }).logger = { info: vi.fn(), error: errorLog };
    (exec as { ctx: unknown }).ctx = ctx;
    const result = await slackBotPostMessageToolSpec.perform(exec);
    expect(JSON.stringify(result)).not.toContain(FAKE_TOKEN);
    expect(errorLog.mock.calls.some((call) => String(call[0]).includes(FAKE_TOKEN))).toBe(false);
  });

  it("pipeline-level redaction (redactSecrets) scrubs the token even if it leaked into an error payload", async () => {
    const { redactSecrets } = await import("../../../src/lib/redaction.js");
    const leaked = { error: `Slack call failed with token ${FAKE_TOKEN}` };
    const redacted = redactSecrets(leaked, [FAKE_TOKEN]);
    expect(JSON.stringify(redacted)).not.toContain(FAKE_TOKEN);
  });

  it("does not fail the post when the permalink lookup fails (best-effort metadata)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const parsedUrl = new URL(url);
      if (parsedUrl.pathname.endsWith("/chat.postMessage")) {
        return new Response(JSON.stringify({ ok: true, ts: "1719000003.000300", channel: "C0123456789" }), {
          status: 200
        });
      }
      return new Response(JSON.stringify({ ok: false, error: "permalink_unavailable" }), { status: 200 });
    });
    const exec = execution(FAKE_TOKEN);
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await slackBotPostMessageToolSpec.perform(exec)) as { data: { permalink?: string } };
    expect(result.data.permalink).toBeUndefined();
  });
});
