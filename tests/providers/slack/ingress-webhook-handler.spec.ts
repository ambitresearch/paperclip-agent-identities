import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { handleSlackWebhook } from "../../../src/providers/slack/ingress/webhook-handler.js";
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
    expect(result.body).toEqual({ challenge: "abc123" });
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
    expect(result.body).toEqual({ challenge: "xyz789" });
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
      event: { type: "app_mention", text: "hi" },
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

  it("acks (200) but skips dispatch for a duplicate/retried event_id", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev001",
      event: { type: "app_mention", text: "hi" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = "1800000000";
    const deps = makeDeps({ rawBody, headers: baseHeaders(timestamp, rawBody), nowEpochSeconds: 1_800_000_000 });

    await handleSlackWebhook(deps as never);
    const second = await handleSlackWebhook(deps as never);

    expect(second.status).toBe(200);
    expect(deps.onAgentEvent).toHaveBeenCalledTimes(1);
  });

  it("fails closed (still acks 200, per Slack's retry-suppression contract) but does not dispatch when routing is ambiguous", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev002",
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

    expect(result.status).toBe(200);
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

  it("authenticates the signature before any JSON.parse of the body — an unsigned request with a malicious/malformed body is rejected at 401, not 400", async () => {
    // A body that is well-formed enough to parse but was never signed by any
    // configured agent's secret must be rejected on authentication grounds
    // (401) before the parse-dependent 400 path is ever reached — proving
    // signature verification does not depend on (and is not ordered after)
    // parsing.
    const rawBody = JSON.stringify({ type: "event_callback", team_id: "T111", api_app_id: "A111" });
    const deps = makeDeps({
      rawBody,
      headers: {}, // no signature at all
      nowEpochSeconds: 1_800_000_000,
    });

    const result = await handleSlackWebhook(deps as never);

    expect(result.status).toBe(401);
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
    expect(deps.onAgentEvent).not.toHaveBeenCalled();
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
        event: { type: "app_mention" },
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
