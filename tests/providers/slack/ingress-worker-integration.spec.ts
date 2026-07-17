import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../../src/manifest.js";
import plugin from "../../../src/worker.js";

// End-to-end coverage that DRO-1005's Slack HTTP Events API ingress is
// actually wired into the plugin's manifest + worker seams -- not just
// unit-tested in isolation. Exercises the real `onWebhook` hook through the
// generic provider-registry `webhooks()`/`handleWebhook` dispatch (see
// src/core/provider-registry.ts, src/providers/slack/ingress/provider-webhook.ts).

const SIGNING_SECRET_ID = "00000000-0000-4000-8000-000000000099";
const SIGNING_SECRET = "worker-integration-signing-secret";
const BOT_TOKEN_SECRET_ID = "00000000-0000-4000-8000-000000000010";
const BOT_TOKEN = "xoxb-worker-integration-token";
const SIGNING_SECRET_REF = {
  type: "secret_ref",
  secretId: SIGNING_SECRET_ID,
  version: "latest",
} as const;
const COMPANY_CONFIG = {
  identities: {
    "agent-1": {
      label: "Agent One",
      teamId: "T111",
      appId: "A111",
      botUserId: "U111",
      credentials: {
        botToken: {
          type: "secret_ref",
          secretId: BOT_TOKEN_SECRET_ID,
          version: "latest",
        },
        signingSecret: SIGNING_SECRET_REF,
      },
    },
  },
} as const;

function sign(secret: string, timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", secret).update(base, "utf8").digest("hex");
  return `v0=${hmac}`;
}

function createConfiguredHarness() {
  const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
  harness.seed({
    companies: [{ id: "company-1", name: "Acme" } as never],
    agents: [{ id: "agent-1", companyId: "company-1", name: "Agent One", status: "idle" } as never],
  });
  const getConfig = vi.fn(async (companyId?: string) =>
    companyId === "company-1" ? structuredClone(COMPANY_CONFIG) : { identities: {} }
  );
  const resolveSecret = vi.fn(async (secretRef: { secretId: string }) =>
    secretRef.secretId === SIGNING_SECRET_ID ? SIGNING_SECRET : BOT_TOKEN
  );
  Object.assign(harness.ctx.config, { get: getConfig });
  Object.assign(harness.ctx.secrets, { resolve: resolveSecret });
  return { harness, getConfig, resolveSecret };
}

describe("Slack Events API ingress - manifest + worker wiring", () => {
  it("advertises the slack-events webhook endpoint in the manifest via the generic registry seam", () => {
    expect(manifest.webhooks).toEqual([
      expect.objectContaining({ endpointKey: "slack-events", displayName: "Slack Events API" }),
    ]);
  });

  it("declares webhook and agent-session capabilities required for ingress", () => {
    expect(manifest.capabilities).toContain("webhooks.receive");
    expect(manifest.capabilities).toContain("agent.sessions.create");
    expect(manifest.capabilities).toContain("agent.sessions.send");
    expect(manifest.capabilities).toContain("agent.sessions.close");
    expect(manifest.capabilities).not.toContain("agents.invoke");
  });

  it("routes a signed event_callback delivery to the matching agent end-to-end", async () => {
    const { harness, getConfig, resolveSecret } = createConfiguredHarness();

    await plugin.definition.setup(harness.ctx);
    const createSpy = vi.spyOn(harness.ctx.agents.sessions, "create");
    const sendSpy = vi.spyOn(harness.ctx.agents.sessions, "sendMessage");

    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev001",
      authorizations: [{ team_id: "T111" }],
      event: { type: "message", channel_type: "im", channel: "D0123456789", user: "U222", text: "hello" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(SIGNING_SECRET, timestamp, rawBody);

    const result = await plugin.definition.onWebhook?.({
      endpointKey: "slack-events",
      companyId: "company-1",
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      rawBody,
      requestId: "req-1",
    });

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(createSpy).toHaveBeenCalledWith("agent-1", "company-1");
    expect(sendSpy).toHaveBeenCalledWith(
      expect.any(String),
      "company-1",
      expect.objectContaining({ reason: "slack-inbound-event", onEvent: expect.any(Function) })
    );
    expect(getConfig).toHaveBeenCalledWith("company-1");
    expect(resolveSecret).toHaveBeenCalledWith(SIGNING_SECRET_REF, {
      companyId: "company-1",
      configPath: "identities.agent-1.credentials.signingSecret",
    });
  });

  it("streams a threaded session response through Slack's native agent reply APIs", async () => {
    const { harness, resolveSecret } = createConfiguredHarness();
    const authFetch = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      team_id: "T111",
      user_id: "U111",
      bot_id: "B111",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", authFetch);
    const slackFetch = vi.fn(async (input: string, _init?: RequestInit) => {
      if (input === "https://slack.com/api/assistant.threads.setStatus") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (input === "https://slack.com/api/chat.startStream") {
        return new Response(JSON.stringify({
          ok: true,
          channel: "D0123456789",
          ts: "1719000001.123456",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (input === "https://slack.com/api/chat.appendStream") {
        return new Response(JSON.stringify({
          ok: true,
          channel: "D0123456789",
          ts: "1719000001.123456",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (input === "https://slack.com/api/chat.stopStream") {
        return new Response(JSON.stringify({
          ok: true,
          channel: "D0123456789",
          ts: "1719000001.123456",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Slack URL: ${input}`);
    });
    Object.assign(harness.ctx.http, { fetch: slackFetch });

    try {
      await plugin.definition.setup(harness.ctx);
      const sendSpy = vi.spyOn(harness.ctx.agents.sessions, "sendMessage");
      const closeSpy = vi.spyOn(harness.ctx.agents.sessions, "close");
      const payload = {
        type: "event_callback",
        team_id: "T111",
        api_app_id: "A111",
        event_id: "Ev-post-reply",
        authorizations: [{ team_id: "T111" }],
        event: {
          type: "message",
          channel_type: "im",
          channel: "D0123456789",
          user: "U222",
          text: "hello",
          ts: "1719000000.123456",
          thread_ts: "1719000000.123456",
        },
      };
      const rawBody = JSON.stringify(payload);
      const timestamp = String(Math.floor(Date.now() / 1000));

      await plugin.definition.onWebhook?.({
        endpointKey: "slack-events",
        companyId: "company-1",
        headers: {
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": sign(SIGNING_SECRET, timestamp, rawBody),
        },
        rawBody,
        requestId: "req-post-reply",
      });

      const sessionId = sendSpy.mock.calls[0][0];
      harness.simulateSessionEvent(sessionId, {
        runId: "run-post-reply",
        seq: 1,
        eventType: "chunk",
        stream: "stdout",
        message: "[paperclip] preparing workspace\n{\"type\":\"system\",\"subtype\":\"hook_started\"}\n",
        payload: null,
      });
      harness.simulateSessionEvent(sessionId, {
        runId: "run-post-reply",
        seq: 2,
        eventType: "chunk",
        stream: "stderr",
        message: "ignored",
        payload: null,
      });
      harness.simulateSessionEvent(sessionId, {
        runId: "run-post-reply",
        seq: 3,
        eventType: "chunk",
        stream: "stdout",
        message: "{\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"draft\"}]}}\n{\"type\":\"res",
        payload: null,
      });
      harness.simulateSessionEvent(sessionId, {
        runId: "run-post-reply",
        seq: 4,
        eventType: "chunk",
        stream: "stdout",
        message: "ult\",\"result\":\"Hello from Paperclip\"}\n",
        payload: null,
      });
      harness.simulateSessionEvent(sessionId, {
        runId: "run-post-reply",
        seq: 5,
        eventType: "done",
        stream: "system",
        message: null,
        payload: null,
      });

      await vi.waitFor(() => {
        expect(slackFetch).toHaveBeenCalledWith(
          "https://slack.com/api/chat.stopStream",
          expect.objectContaining({ method: "POST" }),
        );
      });
      const statusCall = slackFetch.mock.calls.find(([url]) => url === "https://slack.com/api/assistant.threads.setStatus");
      const statusBody = JSON.parse((statusCall?.[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(statusBody).toEqual(expect.objectContaining({
        channel_id: "D0123456789",
        thread_ts: "1719000000.123456",
        status: "is working on your request...",
      }));
      const startCall = slackFetch.mock.calls.find(([url]) => url === "https://slack.com/api/chat.startStream");
      const startBody = JSON.parse((startCall?.[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(startBody).toEqual({
        channel: "D0123456789",
        thread_ts: "1719000000.123456",
        markdown_text: "Hello from Paperclip",
      });
      expect(slackFetch.mock.calls.some(([url]) => url === "https://slack.com/api/chat.postMessage")).toBe(false);
      expect(authFetch).toHaveBeenCalledTimes(1);
      expect(resolveSecret).toHaveBeenCalledWith(
        COMPANY_CONFIG.identities["agent-1"].credentials.botToken,
        {
          companyId: "company-1",
          configPath: "identities.agent-1.credentials.botToken",
        },
      );
      await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledWith(sessionId, "company-1"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not dispatch anything for an unknown endpointKey", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);
    const createSpy = vi.spyOn(harness.ctx.agents.sessions, "create");

    await plugin.definition.onWebhook?.({
      endpointKey: "not-a-real-endpoint",
      companyId: "company-1",
      headers: {},
      rawBody: "{}",
      requestId: "req-2",
    });

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("acks an invalid signature end-to-end without invoking any agent", async () => {
    const { harness } = createConfiguredHarness();

    await plugin.definition.setup(harness.ctx);
    const createSpy = vi.spyOn(harness.ctx.agents.sessions, "create");

    const payload = { type: "event_callback", team_id: "T111", api_app_id: "A111", event_id: "Ev002", event: {} };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));

    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: "slack-events",
        companyId: "company-1",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=deadbeef" },
        rawBody,
        requestId: "req-3",
      })
    ).resolves.toEqual({ status: 401, body: { error: "unauthorized" } });

    expect(createSpy).not.toHaveBeenCalled();
  });

  it("releases the dedup claim when session send fails, so a Slack retry of the same event_id can succeed later", async () => {
    const { harness } = createConfiguredHarness();

    await plugin.definition.setup(harness.ctx);

    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-retry-after-failure",
      authorizations: [{ team_id: "T111" }],
      event: { type: "message", channel_type: "im", channel: "D0123456789", user: "U222", text: "hello" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(SIGNING_SECRET, timestamp, rawBody);

    // First delivery: the session run cannot start.
    const sendSpy = vi
      .spyOn(harness.ctx.agents.sessions, "sendMessage")
      .mockRejectedValueOnce(new Error("agent runtime unavailable"));

    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: "slack-events",
        companyId: "company-1",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
        rawBody,
        requestId: "req-fail-1",
      })
    ).rejects.toThrow("agent runtime unavailable");

    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Slack redelivers the identical event_id (its own retry policy for a
    // failed/slow ack). Because the failed first attempt released its dedup
    // claim, this second delivery must be allowed to start the agent session
    // again -- not be silently dropped as a duplicate.
    await plugin.definition.onWebhook?.({
      endpointKey: "slack-events",
      companyId: "company-1",
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      rawBody,
      requestId: "req-fail-2",
    });

    expect(sendSpy).toHaveBeenCalledTimes(2);
  });
});
