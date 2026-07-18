import { beforeEach, describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  handleSlackWebhook,
  SLACK_WEBHOOK_MAX_BODY_BYTES,
} from "../../../src/providers/slack/ingress/webhook-handler.js";
import { resetSlackRateLimitState } from "../../../src/providers/slack/ingress/rate-limit.js";
import type { SlackAgentIdentity } from "../../../src/providers/slack/config.js";

const SIGNING_SECRET = "test-signing-secret-value";

function sign(timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", SIGNING_SECRET).update(base, "utf8").digest("hex");
  return `v0=${hmac}`;
}

function baseHeaders(timestamp: string, rawBody: string) {
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": sign(timestamp, rawBody),
  };
}

function authorizationsFor(teamId: string) {
  return [{ team_id: teamId }];
}

function makeDeps(overrides: Partial<Parameters<typeof handleSlackWebhook>[0]> = {}) {
  const identities: Record<string, SlackAgentIdentity> = {
    "agent-1": { label: "Agent 1", teamId: "T111", appId: "A111", botUserId: "U111" },
  };

  const dedupSeen = new Set<string>();

  return {
    rawBody: "",
    headers: {},
    nowEpochSeconds: 1_800_000_000,
    getProjectedIdentities: vi.fn(async () => identities),
    resolveSigningSecret: vi.fn(async (_agentId: string) => SIGNING_SECRET),
    shouldProcessEvent: vi.fn(async (agentId: string, eventId: string) => {
      const key = `${agentId}:${eventId}`;
      if (dedupSeen.has(key)) return false;
      dedupSeen.add(key);
      return true;
    }),
    onAgentEvent: vi.fn(async () => undefined),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("handleSlackWebhook", () => {
  beforeEach(() => {
    resetSlackRateLimitState();
  });

  it("responds to Slack's correctly-signed URL verification handshake, checked against a configured identity's secret", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" });
    const timestamp = "1800000000";
    const deps = makeDeps({
      rawBody,
      headers: baseHeaders(timestamp, rawBody),
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(200);
    expect(result.body).toBe("abc123");
  });

  it("rejects an unsigned URL verification handshake (401), never echoing the challenge unverified", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" });
    const deps = makeDeps({
      rawBody,
      headers: {},
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(JSON.stringify(result.body)).not.toContain("abc123");
  });

  it("rejects a URL verification handshake signed with a secret that matches none of the configured identities", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" });
    const timestamp = "1800000000";
    const base = `v0:${timestamp}:${rawBody}`;
    const wrongSignature = `v0=${createHmac("sha256", "some-other-secret").update(base, "utf8").digest("hex")}`;
    const deps = makeDeps({
      rawBody,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": wrongSignature },
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
  });

  it("accepts a correctly-signed URL verification handshake when it matches the second of several configured identities", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "xyz789", token: "x" });
    const timestamp = "1800000000";
    const OTHER_SECRET = "another-agents-signing-secret";
    const base = `v0:${timestamp}:${rawBody}`;
    const signature = `v0=${createHmac("sha256", OTHER_SECRET).update(base, "utf8").digest("hex")}`;

    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": { label: "Agent 1", teamId: "T111", appId: "A111", botUserId: "U111" },
      "agent-2": { label: "Agent 2", teamId: "T222", appId: "A222", botUserId: "U222" },
    };
    const deps = makeDeps({
      rawBody,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      nowEpochSeconds: 1_800_000_000,
      getProjectedIdentities: vi.fn(async () => identities),
      resolveSigningSecret: vi.fn(async (agentId: string) => (agentId === "agent-2" ? OTHER_SECRET : SIGNING_SECRET)),
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(200);
    expect(result.body).toBe("xyz789");
  });

  it("fails closed (401) on a URL verification handshake when no identities are configured yet", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" });
    const timestamp = "1800000000";
    const deps = makeDeps({
      rawBody,
      headers: baseHeaders(timestamp, rawBody),
      nowEpochSeconds: 1_800_000_000,
      getProjectedIdentities: vi.fn(async () => ({})),
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
  });

  it("rejects a request with an invalid signature before parsing routes anything further", async () => {
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T111", api_app_id: "A111" });
    const deps = makeDeps({
      rawBody,
      headers: { "x-slack-request-timestamp": "1800000000", "x-slack-signature": "v0=deadbeef" },
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it("routes a valid event_callback to the matching agent and dedupes/dispatches", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev001",
      authorizations: authorizationsFor("T111"),
      event: { type: "message", channel_type: "im", channel: "D111", user: "U222", text: "hi" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody), nowEpochSeconds: 1_800_000_000 });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(200);
    expect(deps.onAgentEvent).toHaveBeenCalledTimes(1);
    expect(deps.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", event: payload.event })
    );
  });

  it("routes a user-authored public-channel app mention to the matching agent", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-public-mention",
      authorizations: authorizationsFor("T111"),
      event: { type: "app_mention", channel: "C111", user: "U222", text: "<@U111> hi" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody), nowEpochSeconds: 1_800_000_000 });

    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(deps.shouldProcessEvent).toHaveBeenCalledWith("agent-1", "Ev-public-mention");
    expect(deps.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", event: payload.event }),
    );
  });

  it.each([
    ["channel", "<!channel>", "Ev-public-channel-broadcast"],
    ["group", "<!here>", "Ev-private-group-broadcast"],
    ["mpim", "<!everyone>", "Ev-mpim-broadcast"],
  ])("routes a user-authored %s broadcast to the matching agent", async (channelType, token, eventId) => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: eventId,
      authorizations: authorizationsFor("T111"),
      event: {
        type: "message",
        channel_type: channelType,
        channel: channelType === "channel" ? "C111" : "G111",
        user: "U222",
        text: `${token} please respond`,
        ts: "1719000000.123456",
      },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({
      rawBody,
      headers: baseHeaders(timestamp, rawBody),
      nowEpochSeconds: 1_800_000_000,
    });

    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(deps.shouldProcessEvent).toHaveBeenCalledWith("agent-1", eventId);
    expect(deps.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", event: payload.event }),
    );
  });

  it("routes a user-authored reply in a public-channel thread without another mention", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-public-thread-reply",
      authorizations: authorizationsFor("T111"),
      event: {
        type: "message",
        channel_type: "channel",
        channel: "C111",
        user: "U222",
        text: "howdy",
        ts: "1719000001.123456",
        thread_ts: "1719000000.123456",
      },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody) });

    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(deps.shouldProcessEvent).toHaveBeenCalledWith("agent-1", "Ev-public-thread-reply");
    expect(deps.onAgentEvent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", event: payload.event }),
    );
  });

  it.each([
    ["a non-message event", { type: "reaction_added", channel: "C111", user: "U222" }],
    ["a channel message", { type: "message", channel_type: "channel", channel: "C111", user: "U222" }],
    ["a message subtype", { type: "message", channel_type: "im", channel: "D111", user: "U222", subtype: "message_changed" }],
    ["a bot message", { type: "message", channel_type: "im", channel: "D111", user: "U222", bot_id: "B111" }],
    ["a bot-authored app mention", { type: "app_mention", channel: "C111", user: "U222", bot_id: "B111" }],
    ["a message with a blank user", { type: "message", channel_type: "im", channel: "D111", user: "   " }],
    ["a message sent by the configured bot itself", { type: "message", channel_type: "im", channel: "D111", user: "U111" }],
    ["an app mention sent by the configured bot itself", { type: "app_mention", channel: "C111", user: "U111" }],
  ])("acks but does not claim or dispatch %s", async (_label, event) => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-filtered-message",
      authorizations: authorizationsFor("T111"),
      event,
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody) });

    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 200,
      body: { ok: true, dispatched: false },
    });
    expect(deps.shouldProcessEvent).not.toHaveBeenCalled();
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["array", []],
    ["missing type", {}],
    ["blank type", { type: "   " }],
  ])("acks but does not claim or dispatch an event_callback whose event is %s", async (_label, event) => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-invalid-event",
      authorizations: authorizationsFor("T111"),
      event,
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody) });

    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 200,
      body: { ok: true, dispatched: false },
    });
    expect(deps.shouldProcessEvent).not.toHaveBeenCalled();
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it("acks (200) but skips dispatch for a duplicate/retried event_id", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev001",
      authorizations: authorizationsFor("T111"),
      event: { type: "message", channel_type: "im", channel: "D111", user: "U222", text: "hi" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody), nowEpochSeconds: 1_800_000_000 });

    await handleSlackWebhook(deps as never);
    const second = await handleSlackWebhook(deps as never);

    expect(second.status).toBe(200);
    expect(deps.onAgentEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["blank", "   "],
  ])("acks (200) but fails closed when an event_callback has a %s event_id", async (_label, eventId) => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: eventId,
      authorizations: authorizationsFor("T111"),
      event: { type: "app_mention", text: "hi" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody), nowEpochSeconds: 1_800_000_000 });

    const result = await handleSlackWebhook(deps as never);

    expect(result).toEqual({ status: 200, body: { ok: true, dispatched: false } });
    expect(deps.shouldProcessEvent).not.toHaveBeenCalled();
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
    ["malformed", [null, { team_id: " " }]],
    ["for a different team", authorizationsFor("T222")],
  ])("acks (200) but fails closed when the authorizations list is %s", async (_label, authorizations) => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-auth",
      authorizations,
      event: { type: "app_mention", text: "hi" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody), nowEpochSeconds: 1_800_000_000 });

    const result = await handleSlackWebhook(deps as never);

    expect(result).toEqual({ status: 200, body: { ok: true, dispatched: false } });
    expect(deps.shouldProcessEvent).not.toHaveBeenCalled();
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it("rejects ambiguous routing before resolving any signing secret", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev002",
      authorizations: authorizationsFor("T111"),
      event: { type: "app_mention", text: "hi" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": { label: "Agent 1", teamId: "T111", appId: "A111", botUserId: "U111" },
      "agent-2": { label: "Agent 2", teamId: "T111", appId: "A111", botUserId: "U222" },
    };
    const deps = makeDeps({
      rawBody,
      headers: baseHeaders(timestamp, rawBody),
      nowEpochSeconds: 1_800_000_000,
      getProjectedIdentities: vi.fn(async () => identities),
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(deps.resolveSigningSecret).not.toHaveBeenCalled();
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it("rejects a stale timestamp outside the replay window even with a correct signature", async () => {
    const payload = { type: "event_callback", team_id: "T111", api_app_id: "A111", event_id: "Ev003", event: {} };
    const rawBody = JSON.stringify(payload);
    const staleTimestamp = String(1_800_000_000 - 400);
    const deps = makeDeps({
      rawBody,
      headers: baseHeaders(staleTimestamp, rawBody),
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it("returns 400 for an unparseable body", async () => {
    const rawBody = "not json";
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody), nowEpochSeconds: 1_800_000_000 });

    // Signature check happens on the raw body regardless of parseability, so
    // a validly-signed non-JSON body must still fail closed at the parse
    // step, not silently succeed with an empty/garbage event.
    const result = await handleSlackWebhook(deps as never);
    expect(result.status).toBe(400);
  });

  it("accepts a request body exactly at the byte limit", async () => {
    const prefix = '{"type":"url_verification","challenge":"at-limit","padding":"';
    const suffix = '"}';
    const rawBody = `${prefix}${"x".repeat(SLACK_WEBHOOK_MAX_BODY_BYTES - prefix.length - suffix.length)}${suffix}`;
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody) });

    expect(Buffer.byteLength(rawBody, "utf8")).toBe(SLACK_WEBHOOK_MAX_BODY_BYTES);
    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 200,
      body: "at-limit",
    });
    expect(deps.resolveSigningSecret).toHaveBeenCalledTimes(1);
  });

  it("rejects a body over the byte limit before identity or secret resolution", async () => {
    const rawBody = "é".repeat(Math.floor(SLACK_WEBHOOK_MAX_BODY_BYTES / 2) + 1);
    const deps = makeDeps({
      rawBody,
      headers: { "x-slack-request-timestamp": "1800000000", "x-slack-signature": "v0=unused" },
    });

    expect(rawBody.length).toBeLessThan(SLACK_WEBHOOK_MAX_BODY_BYTES);
    expect(Buffer.byteLength(rawBody, "utf8")).toBeGreaterThan(SLACK_WEBHOOK_MAX_BODY_BYTES);
    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 413,
      body: { error: "payload too large" },
    });
    expect(deps.getProjectedIdentities).not.toHaveBeenCalled();
    expect(deps.resolveSigningSecret).not.toHaveBeenCalled();
  });

  it("never includes the signing secret or any token in the response body on failure", async () => {
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T111", api_app_id: "A111" });
    const deps = makeDeps({
      rawBody,
      headers: { "x-slack-request-timestamp": "1800000000", "x-slack-signature": "v0=deadbeef" },
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(JSON.stringify(result.body)).not.toContain(SIGNING_SECRET);
  });

  it("throws a sanitized retryable failure when no signature can be checked because secret resolution failed", async () => {
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T111", api_app_id: "A111" });
    const timestamp = "1800000000";
    const deps = makeDeps({
      rawBody,
      headers: baseHeaders(timestamp, rawBody),
      nowEpochSeconds: 1_800_000_000,
      resolveSigningSecret: vi.fn(async () => {
        throw new Error("sensitive vault path /internal/slack/signing-secret");
      }),
    });

    let failure: unknown;
    try {
      await handleSlackWebhook(deps as never);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/temporarily unavailable/i);
    expect((failure as Error).message).not.toContain("/internal/slack/signing-secret");
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it("rejects missing authentication headers before routing-hint parsing or secret work", async () => {
    const rawBody = "not json";
    const deps = makeDeps({
      rawBody,
      headers: {},
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(deps.getProjectedIdentities).not.toHaveBeenCalled();
    expect(deps.resolveSigningSecret).not.toHaveBeenCalled();
  });

  it("fails closed (401) when the routed agent's own secret did not match this request's signature (cross-agent confused-deputy defense)", async () => {
    // Two agents configured; the request is correctly signed with agent-2's
    // secret, but routes (by team/app) to agent-1. Even though the request
    // authenticated against *some* configured identity, it must not be
    // trusted as agent-1's event unless agent-1's own secret is the one that
    // matched.
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev999",
      authorizations: authorizationsFor("T111"),
      event: { type: "app_mention" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const OTHER_SECRET = "agent-2-secret";
    const base = `v0:${timestamp}:${rawBody}`;
    const signature = `v0=${createHmac("sha256", OTHER_SECRET).update(base, "utf8").digest("hex")}`;

    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": { label: "Agent 1", teamId: "T111", appId: "A111", botUserId: "U111" },
      "agent-2": { label: "Agent 2", teamId: "T222", appId: "A222", botUserId: "U222" },
    };
    const deps = makeDeps({
      rawBody,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      nowEpochSeconds: 1_800_000_000,
      getProjectedIdentities: vi.fn(async () => identities),
      resolveSigningSecret: vi.fn(async (agentId: string) => (agentId === "agent-2" ? OTHER_SECRET : SIGNING_SECRET)),
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(deps.resolveSigningSecret).toHaveBeenCalledTimes(1);
    expect(deps.resolveSigningSecret).toHaveBeenCalledWith("agent-1");
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
  });

  it("accepts a valid signature even when the host preserves header casing (headers are matched case-insensitively, not just exact/all-lowercase)", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "case-ok", token: "x" });
    const timestamp = "1800000000";
    const { "x-slack-request-timestamp": ts, "x-slack-signature": sig } = baseHeaders(timestamp, rawBody);
    const deps = makeDeps({
      rawBody,
      headers: { "X-Slack-Request-Timestamp": ts, "X-Slack-Signature": sig },
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(200);
    expect(result.body).toBe("case-ok");
  });

  it("rejects a request missing the signature/timestamp headers before resolving any agent's signing secret (cheap early reject)", async () => {
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T111", api_app_id: "A111" });
    const deps = makeDeps({ rawBody, headers: {}, nowEpochSeconds: 1_800_000_000 });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(deps.resolveSigningSecret).not.toHaveBeenCalled();
  });

  it("rejects a request with a blank signature header before resolving any agent's signing secret", async () => {
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T111", api_app_id: "A111" });
    const deps = makeDeps({
      rawBody,
      headers: { "x-slack-request-timestamp": "1800000000", "x-slack-signature": "   " },
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
    expect(deps.resolveSigningSecret).not.toHaveBeenCalled();
  });

  it("resolves only the exactly routed agent's signing secret for a normal multi-app event", async () => {
    const identities = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `agent-${index}`,
        {
          label: `Agent ${index}`,
          teamId: `T${index}`,
          appId: `A${index}`,
          botUserId: `U${index}`,
        },
      ]),
    ) as Record<string, SlackAgentIdentity>;
    const payload = {
      type: "event_callback",
      team_id: "T9",
      api_app_id: "A9",
      event_id: "Ev-batched-secret-check",
      authorizations: authorizationsFor("T9"),
      event: { type: "message", channel_type: "im", channel: "D9", user: "U-human" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({
      rawBody,
      headers: baseHeaders(timestamp, rawBody),
      getProjectedIdentities: vi.fn(async () => identities),
      resolveSigningSecret: vi.fn(async (agentId: string) => {
        return agentId === "agent-9" ? SIGNING_SECRET : "non-matching-secret";
      }),
    });

    await expect(handleSlackWebhook(deps as never)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(deps.resolveSigningSecret).toHaveBeenCalledTimes(1);
    expect(deps.resolveSigningSecret).toHaveBeenCalledWith("agent-9");
  });
});

describe("handleSlackWebhook rate limiting", () => {
  it("returns 429 once a team exceeds the configured request rate, without dispatching", async () => {
    const { resetSlackRateLimitState } = await import("../../../src/providers/slack/ingress/rate-limit.js");
    resetSlackRateLimitState();

    const teamId = "T-rate-limited";
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": { label: "Agent 1", teamId, appId: "A111", botUserId: "U111" },
    };

    let callCount = 0;
    const results = [];
    for (let i = 0; i < 35; i++) {
      const payload = {
        type: "event_callback",
        team_id: teamId,
        api_app_id: "A111",
        event_id: `Ev${i}`,
        authorizations: authorizationsFor(teamId),
        event: { type: "message", channel_type: "im", channel: "D111", user: "U222" },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = "1800000000";
      const deps = makeDeps({
        rawBody,
        headers: baseHeaders(timestamp, rawBody),
        nowEpochSeconds: 1_800_000_000,
        nowMs: 1_800_000_000_000,
        getProjectedIdentities: vi.fn(async () => identities),
      });
      results.push(await handleSlackWebhook(deps as never));
      callCount++;
    }

    expect(callCount).toBe(35);
    expect(results.some((r) => r.status === 429)).toBe(true);
    expect(results.filter((r) => r.status === 200).length).toBeLessThan(35);

    resetSlackRateLimitState();
  });
});
