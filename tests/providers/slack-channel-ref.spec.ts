import { describe, it, expect, vi } from "vitest";
import {
  resolveSlackChannelRef,
  normalizeSlackChannelId,
  normalizeSlackTeamId,
  normalizeSlackThreadTs
} from "../../src/providers/slack/channel-ref.js";
import type { ResourceRefResolverInput } from "../../src/core/provider-contract.js";
import type { SlackAgentIdentity } from "../../src/providers/slack/config.js";

const identity = {
  agentId: "agent-1",
  identity: {
    label: "Bot",
    teamId: "T0123456789",
    appId: "A0123456789",
    botUserId: "U0123456789"
  } as SlackAgentIdentity
};

const runCtx = { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never;

function buildCtx() {
  return {
    activity: { log: vi.fn(async () => {}) }
  } as never;
}

function buildInput(overrides: Partial<ResourceRefResolverInput<SlackAgentIdentity>> = {}) {
  return {
    params: {},
    identity,
    ctx: buildCtx(),
    runCtx,
    ...overrides
  } as ResourceRefResolverInput<SlackAgentIdentity>;
}

describe("normalizeSlackChannelId", () => {
  it("accepts a well-formed public channel ID", () => {
    expect(normalizeSlackChannelId("C0123456789")).toBe("C0123456789");
  });

  it("accepts group/private and DM prefixes", () => {
    expect(normalizeSlackChannelId("G0123456789")).toBe("G0123456789");
    expect(normalizeSlackChannelId("D0123456789")).toBe("D0123456789");
  });

  it("rejects a channel name", () => {
    expect(normalizeSlackChannelId("general")).toBeNull();
    expect(normalizeSlackChannelId("#general")).toBeNull();
  });

  it("rejects a URL / deep link", () => {
    expect(normalizeSlackChannelId("https://acme.slack.com/archives/C0123456789")).toBeNull();
    expect(normalizeSlackChannelId("https://slack.com/app_redirect?channel=C0123456789")).toBeNull();
  });

  it("rejects empty/whitespace/lowercase/malformed", () => {
    expect(normalizeSlackChannelId("")).toBeNull();
    expect(normalizeSlackChannelId("   ")).toBeNull();
    expect(normalizeSlackChannelId("c0123456789")).toBeNull();
    expect(normalizeSlackChannelId("C123")).toBeNull();
    expect(normalizeSlackChannelId(null)).toBeNull();
    expect(normalizeSlackChannelId(42)).toBeNull();
  });
});

describe("normalizeSlackTeamId", () => {
  it("accepts a well-formed team ID", () => {
    expect(normalizeSlackTeamId("T0123456789")).toBe("T0123456789");
  });

  it("rejects malformed/URL-like/empty", () => {
    expect(normalizeSlackTeamId("t0123456789")).toBeNull();
    expect(normalizeSlackTeamId("T123")).toBeNull();
    expect(normalizeSlackTeamId("https://acme.slack.com")).toBeNull();
    expect(normalizeSlackTeamId("")).toBeNull();
    expect(normalizeSlackTeamId(undefined)).toBeNull();
  });
});

describe("normalizeSlackThreadTs", () => {
  it("returns undefined when omitted (optional field)", () => {
    expect(normalizeSlackThreadTs(undefined)).toBeUndefined();
  });

  it("accepts a well-formed thread timestamp", () => {
    expect(normalizeSlackThreadTs("1719000000.123456")).toBe("1719000000.123456");
  });

  it("rejects malformed timestamps", () => {
    expect(normalizeSlackThreadTs("not-a-ts")).toBeNull();
    expect(normalizeSlackThreadTs("1719000000")).toBeNull();
    expect(normalizeSlackThreadTs("")).toBeNull();
    expect(normalizeSlackThreadTs(123)).toBeNull();
  });
});

describe("resolveSlackChannelRef", () => {
  it("resolves a channel ref defaulting teamId to the identity's own team", async () => {
    const input = buildInput({ params: { channel: "C0123456789" } });
    const res = await resolveSlackChannelRef(input, { channel: "C0123456789" });
    expect(res).toEqual({
      ok: true,
      ref: { kind: "slack-channel", teamId: "T0123456789", channel: "C0123456789" }
    });
  });

  it("includes threadTs separately when provided, keeping it apart from identity", async () => {
    const input = buildInput({});
    const res = await resolveSlackChannelRef(input, {
      channel: "C0123456789",
      threadTs: "1719000000.123456"
    });
    expect(res).toEqual({
      ok: true,
      ref: {
        kind: "slack-channel",
        teamId: "T0123456789",
        channel: "C0123456789",
        threadTs: "1719000000.123456"
      }
    });
  });

  it("accepts an explicit teamId that matches the identity", async () => {
    const input = buildInput({});
    const res = await resolveSlackChannelRef(input, { channel: "C0123456789", teamId: "T0123456789" });
    expect(res.ok).toBe(true);
  });

  it("fails closed and audits on a malformed channel ID", async () => {
    const ctx = buildCtx();
    const input = buildInput({ ctx });
    const res = await resolveSlackChannelRef(input, { channel: "general" });
    expect(res).toEqual({
      ok: false,
      error:
        "Invalid channel. Provide a resolved Slack conversation ID (e.g. 'C0123456789'), not a channel name or URL."
    });
    expect((ctx as { activity: { log: ReturnType<typeof vi.fn> } }).activity.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: "invalid_channel" })
      })
    );
  });

  it("fails closed on a URL-shaped channel ref", async () => {
    const input = buildInput({});
    const res = await resolveSlackChannelRef(input, {
      channel: "https://acme.slack.com/archives/C0123456789"
    });
    expect(res.ok).toBe(false);
  });

  it("fails closed on a malformed threadTs", async () => {
    const input = buildInput({});
    const res = await resolveSlackChannelRef(input, { channel: "C0123456789", threadTs: "bogus" });
    expect(res).toEqual({
      ok: false,
      error: "Invalid threadTs. Expected Slack's '<seconds>.<micros>' timestamp format."
    });
  });

  it("fails closed on a malformed explicit teamId", async () => {
    const input = buildInput({});
    const res = await resolveSlackChannelRef(input, { channel: "C0123456789", teamId: "not-a-team" });
    expect(res).toEqual({
      ok: false,
      error: "Invalid teamId. Expected a Slack team ID (e.g. 'T0123456789')."
    });
  });

  it("denies and audits cross-workspace teamId mismatch before any credential exists", async () => {
    const ctx = buildCtx();
    const input = buildInput({ ctx });
    const res = await resolveSlackChannelRef(input, { channel: "C0123456789", teamId: "T9999999999" });
    expect(res).toEqual({
      ok: false,
      error: "Slack resource denied: workspace mismatch. Expected team 'T0123456789', got 'T9999999999'."
    });
    expect((ctx as { activity: { log: ReturnType<typeof vi.fn> } }).activity.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: "denied_team_mismatch" })
      })
    );
  });

  it("handles private-channel (G-prefixed) and DM (D-prefixed) refs identically to public channels", async () => {
    const input = buildInput({});
    const privateRes = await resolveSlackChannelRef(input, { channel: "G0123456789" });
    const dmRes = await resolveSlackChannelRef(input, { channel: "D0123456789" });
    expect(privateRes.ok).toBe(true);
    expect(dmRes.ok).toBe(true);
  });
});
