import { describe, it, expect, vi } from "vitest";
import { slackAddReactionToolSpec, slackRemoveReactionToolSpec } from "../../../src/providers/slack/tools/react.js";
import { createProviderTool } from "../../../src/core/tool-pipeline.js";
import type { IdentityProvider } from "../../../src/core/provider-contract.js";
import type { SlackAgentIdentity } from "../../../src/providers/slack/config.js";
import type { SlackChannelRef } from "../../../src/providers/slack/channel-ref.js";

const identity: SlackAgentIdentity = {
  label: "Bot",
  teamId: "T0123456789",
  appId: "A0123456789",
  botUserId: "U0123456789",
  defaultChannel: "C0123456789"
};

const runCtx = { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never;

function buildCtx(fetchImpl: ReturnType<typeof vi.fn>) {
  return {
    http: { fetch: fetchImpl },
    activity: { log: vi.fn(async () => {}) },
    logger: { error: vi.fn(), info: vi.fn() },
    secrets: { resolve: vi.fn(async () => "xoxb-secret") }
  } as never;
}

function jsonResponse(ok: boolean, body: Record<string, unknown>) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body
  } as Response;
}

describe("slackAddReactionToolSpec / slackRemoveReactionToolSpec — validateParams", () => {
  it("accepts valid params with explicit channelId", () => {
    const result = slackAddReactionToolSpec.validateParams({
      channelId: "C0123456789",
      messageTs: "1719000000.123456",
      reaction: "thumbsup"
    });
    expect(result).toEqual({
      ok: true,
      params: { channelId: "C0123456789", messageTs: "1719000000.123456", reaction: "thumbsup" }
    });
  });

  it("accepts valid params without channelId (falls back to default channel later)", () => {
    const result = slackAddReactionToolSpec.validateParams({
      messageTs: "1719000000.123456",
      reaction: "thumbsup"
    });
    expect(result).toEqual({
      ok: true,
      params: { messageTs: "1719000000.123456", reaction: "thumbsup" }
    });
  });

  it("rejects malformed messageTs locally, before any identity/credential work", () => {
    const result = slackAddReactionToolSpec.validateParams({
      messageTs: "not-a-timestamp",
      reaction: "thumbsup"
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed reaction/emoji locally", () => {
    const result = slackAddReactionToolSpec.validateParams({
      messageTs: "1719000000.123456",
      reaction: ":thumbsup:"
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown fields", () => {
    const result = slackAddReactionToolSpec.validateParams({
      messageTs: "1719000000.123456",
      reaction: "thumbsup",
      blocks: []
    });
    expect(result).toEqual({ ok: false, error: "Unknown parameter(s): blocks" });
  });

  it("rejects a malformed channelId", () => {
    const result = slackAddReactionToolSpec.validateParams({
      channelId: "general",
      messageTs: "1719000000.123456",
      reaction: "thumbsup"
    });
    expect(result.ok).toBe(false);
  });
});

describe("resolveResourceRef — wrong-team references fail before credentials", () => {
  it("denies a teamId mismatch and never resolves resourceRef", async () => {
    const fetchImpl = vi.fn();
    const ctx = buildCtx(fetchImpl);
    const input = {
      params: { channelId: "C0123456789", messageTs: "1719000000.123456", reaction: "thumbsup", teamId: "T9999999999" },
      identity: { agentId: "agent-1", identity },
      ctx,
      runCtx
    } as never;
    const resolution = await slackAddReactionToolSpec.resolveResourceRef!(input);
    expect(resolution.ok).toBe(false);
    // No credential/API call was ever attempted.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back to the identity's default channel when channelId is omitted", async () => {
    const ctx = buildCtx(vi.fn());
    const input = {
      params: { messageTs: "1719000000.123456", reaction: "thumbsup" },
      identity: { agentId: "agent-1", identity },
      ctx,
      runCtx
    } as never;
    const resolution = await slackAddReactionToolSpec.resolveResourceRef!(input);
    expect(resolution).toEqual({
      ok: true,
      ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789" }
    });
  });

  it("fails closed when channelId is omitted and no default channel is configured", async () => {
    const ctx = buildCtx(vi.fn());
    const input = {
      params: { messageTs: "1719000000.123456", reaction: "thumbsup" },
      identity: { agentId: "agent-1", identity: { ...identity, defaultChannel: undefined } },
      ctx,
      runCtx
    } as never;
    const resolution = await slackAddReactionToolSpec.resolveResourceRef!(input);
    expect(resolution.ok).toBe(false);
  });
});

function buildExecution(fetchImpl: ReturnType<typeof vi.fn>) {
  const ctx = buildCtx(fetchImpl);
  const ref: SlackChannelRef = { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789" };
  return {
    token: "xoxb-secret",
    identity: { agentId: "agent-1", identity },
    resourceRef: ref,
    params: { messageTs: "1719000000.123456", reaction: "thumbsup" },
    ctx,
    runCtx
  } as never;
}

describe("slackAddReactionToolSpec.perform", () => {
  it("calls reactions.add and reports success", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://slack.com/api/reactions.add");
      return jsonResponse(true, { ok: true });
    });
    const result = (await slackAddReactionToolSpec.perform(buildExecution(fetchImpl))) as {
      content: string;
      data: { channelId: string; messageTs: string; reaction: string; action: string };
    };
    expect(result.data).toEqual({
      channelId: "C0123456789",
      messageTs: "1719000000.123456",
      reaction: "thumbsup",
      action: "added"
    });
  });

  it("treats already_reacted as a caller-idempotent success, not an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, { ok: false, error: "already_reacted" }));
    const result = (await slackAddReactionToolSpec.perform(buildExecution(fetchImpl))) as {
      data: { action: string };
    };
    expect(result.data.action).toBe("added");
  });

  it("fails closed on a real Slack API error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, { ok: false, error: "channel_not_found" }));
    const result = (await slackAddReactionToolSpec.perform(buildExecution(fetchImpl))) as { error: string };
    expect(result.error).toContain("channel_not_found");
  });

  it("never leaks the token in an error message", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const result = (await slackAddReactionToolSpec.perform(buildExecution(fetchImpl))) as { error: string };
    expect(result.error).not.toContain("xoxb-secret");
  });
});

describe("slackRemoveReactionToolSpec.perform", () => {
  it("calls reactions.remove and reports success", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://slack.com/api/reactions.remove");
      return jsonResponse(true, { ok: true });
    });
    const result = (await slackRemoveReactionToolSpec.perform(buildExecution(fetchImpl))) as {
      data: { action: string };
    };
    expect(result.data.action).toBe("removed");
  });

  it("treats no_reaction as a caller-idempotent success, not an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, { ok: false, error: "no_reaction" }));
    const result = (await slackRemoveReactionToolSpec.perform(buildExecution(fetchImpl))) as {
      data: { action: string };
    };
    expect(result.data.action).toBe("removed");
  });

  it("fails closed on a permission error removing someone else's reaction", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(false, { ok: false, error: "no_permission" }));
    const result = (await slackRemoveReactionToolSpec.perform(buildExecution(fetchImpl))) as { error: string };
    expect(result.error).toContain("no_permission");
  });
});

describe("end-to-end through the shared pipeline", () => {
  it("requires a credential (requiresCredential defaults to true)", () => {
    expect(slackAddReactionToolSpec.requiresCredential).not.toBe(false);
    expect(slackRemoveReactionToolSpec.requiresCredential).not.toBe(false);
  });

  it("full pipeline: validate -> identity -> resourceRef -> credential -> perform -> redact", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(true, { ok: true }));
    const ctx = buildCtx(fetchImpl);
    const provider = {
      id: "slack",
      definition: { id: "slack", name: "Slack", status: "coming-soon", description: "" },
      validateConfig: () => ({}),
      projectPluginConfig: () => ({}),
      resolveCredential: async () => ({ token: "xoxb-secret", secrets: ["xoxb-secret"] }),
      tools: [],
      manifestTools: []
    } as unknown as IdentityProvider<SlackAgentIdentity, SlackChannelRef>;

    const registered = createProviderTool(provider, slackAddReactionToolSpec, ctx, {
      resolveIdentity: async () => ({ agentId: "agent-1", identity }),
      redactSecrets: (value, secrets) => {
        let serialized = JSON.stringify(value);
        for (const secret of secrets) {
          serialized = serialized.split(secret).join("[REDACTED]");
        }
        return JSON.parse(serialized);
      }
    });

    const result = (await registered.handler(
      { channelId: "C0123456789", messageTs: "1719000000.123456", reaction: "thumbsup" },
      runCtx
    )) as { data: { action: string } };
    expect(result.data.action).toBe("added");
    expect(JSON.stringify(result)).not.toContain("xoxb-secret");
  });

  it("full pipeline denies a wrong-team reference before any credential resolution", async () => {
    const fetchImpl = vi.fn();
    const ctx = buildCtx(fetchImpl);
    const resolveCredential = vi.fn(async () => ({ token: "xoxb-secret", secrets: ["xoxb-secret"] }));
    const provider = {
      id: "slack",
      definition: { id: "slack", name: "Slack", status: "coming-soon", description: "" },
      validateConfig: () => ({}),
      projectPluginConfig: () => ({}),
      resolveCredential,
      tools: [],
      manifestTools: []
    } as unknown as IdentityProvider<SlackAgentIdentity, SlackChannelRef>;

    const registered = createProviderTool(provider, slackAddReactionToolSpec, ctx, {
      resolveIdentity: async () => ({ agentId: "agent-1", identity }),
      redactSecrets: (value) => value
    });

    const result = (await registered.handler(
      { channelId: "C0123456789", messageTs: "1719000000.123456", reaction: "thumbsup", teamId: "T9999999999" },
      runCtx
    )) as { error: string };

    expect(result.error).toContain("workspace mismatch");
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
