import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
  slackWebhookDeclarations,
  handleSlackProviderWebhook,
} from "../../../src/providers/slack/ingress/provider-webhook.js";
import { SLACK_WEBHOOK_MAX_BODY_BYTES } from "../../../src/providers/slack/ingress/webhook-handler.js";
import { CONFIG_SCOPE } from "../../../src/config-source.js";
import { BOT_IDENTITY_SETTINGS_VERSION } from "../../../src/core/identity-config.js";
import { CREDENTIAL_SIDECAR_PATH_ENV, upsertCredentialSidecarIdentity } from "../../../src/credential-sidecar.js";

const SIGNING_SECRET = "provider-webhook-signing-secret";
const SIGNING_SECRET_ID = "00000000-0000-4000-8000-000000000001";

function sign(timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", SIGNING_SECRET).update(base, "utf8").digest("hex");
  return `v0=${hmac}`;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const settingsState = {
    version: BOT_IDENTITY_SETTINGS_VERSION,
    identities: {
      "agent-1:slack": {
        provider: "slack",
        id: "agent-1:slack",
        agentId: "agent-1",
        label: "Agent 1",
        slack: { teamId: "T111", appId: "A111", botUserId: "U111" },
      },
    },
  };
  const stateStore = new Map<string, unknown>();
  const stateKey = (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
    `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`;

  return {
    config: {
      get: vi.fn(async () => ({ identities: {} })),
    },
    state: {
      get: vi.fn(async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        if (key.stateKey === CONFIG_SCOPE.stateKey) return settingsState;
        return stateStore.get(stateKey(key)) ?? null;
      }),
      set: vi.fn(async (
        key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string },
        value: unknown,
      ) => {
        stateStore.set(stateKey(key), value);
      }),
      delete: vi.fn(async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        stateStore.delete(stateKey(key));
      }),
    },
    secrets: {
      resolve: vi.fn(async (secretRef: string) => (secretRef === SIGNING_SECRET_ID ? SIGNING_SECRET : "unexpected")),
    },
    agents: {
      list: vi.fn(async () => []),
      get: vi.fn(async (agentId: string, companyId: string) =>
        agentId === "agent-1" && companyId === "co-1" ? { id: agentId, companyId } : null
      ),
      invoke: vi.fn(async () => ({ runId: "run-1" })),
    },
    companies: {
      list: vi.fn(async () => [{ id: "co-1", name: "Co 1" }]),
      get: vi.fn(async () => null),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
}

describe("slackWebhookDeclarations", () => {
  it("declares exactly the slack-events endpoint", () => {
    expect(slackWebhookDeclarations).toHaveLength(1);
    expect(slackWebhookDeclarations[0].endpointKey).toBe(SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY);
  });
});

describe("handleSlackProviderWebhook", () => {
  const originalPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "slack-provider-webhook-sidecar-"));
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = join(directory, "credentials.json");
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000002", signingSecretId: SIGNING_SECRET_ID },
    });
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  it("resolves the signing secret via the sidecar, verifies the signature, and invokes the routed agent with its resolved companyId", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev001",
      authorizations: [{ team_id: "T111" }],
      event: { type: "app_mention", text: "hello" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const ctx = makeCtx();

    await handleSlackProviderWebhook(
      {
        endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
        rawBody,
        requestId: "req-1",
      },
      ctx as never
    );

    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.agents.invoke).toHaveBeenCalledWith(
      "agent-1",
      "co-1",
      expect.objectContaining({ reason: "slack-inbound-event" })
    );
  });

  it("rejects an oversized body before reading identities or resolving a secret", async () => {
    const ctx = makeCtx();

    await handleSlackProviderWebhook(
      {
        endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
        headers: { "x-slack-request-timestamp": "1800000000", "x-slack-signature": "v0=unused" },
        rawBody: "x".repeat(SLACK_WEBHOOK_MAX_BODY_BYTES + 1),
        requestId: "req-oversized",
      },
      ctx as never,
    );

    expect(ctx.config.get).not.toHaveBeenCalled();
    expect(ctx.state.get).not.toHaveBeenCalled();
    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(ctx.agents.invoke).not.toHaveBeenCalled();
  });

  it("uses valid instance config ahead of stale settings state for both authentication and routing", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T222",
      api_app_id: "A222",
      event_id: "Ev-instance-config",
      authorizations: [{ team_id: "T222" }],
      event: { type: "app_mention", text: "current config" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const ctx = makeCtx({
      config: {
        get: vi.fn(async () => ({
          identities: {
            "agent-1": {
              label: "Agent 1 from instance config",
              teamId: "T222",
              appId: "A222",
              botUserId: "U222",
            },
          },
        })),
      },
    });

    await handleSlackProviderWebhook(
      {
        endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
        rawBody,
        requestId: "req-instance-config",
      },
      ctx as never,
    );

    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
    expect(ctx.config.get).toHaveBeenCalledTimes(1);
    expect(
      ctx.state.get.mock.calls.filter(([key]) => key.stateKey === CONFIG_SCOPE.stateKey),
    ).toHaveLength(1);
  });

  it("does not invoke any agent when the signature is invalid, and returns without throwing", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      authorizations: [{ team_id: "T111" }],
      event: {},
    };
    const rawBody = JSON.stringify(payload);
    const ctx = makeCtx();

    await expect(
      handleSlackProviderWebhook(
        {
          endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
          headers: { "x-slack-request-timestamp": "1800000000", "x-slack-signature": "v0=deadbeef" },
          rawBody,
          requestId: "req-2",
        },
        ctx as never
      )
    ).resolves.toBeUndefined();

    expect(ctx.agents.invoke).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "Slack webhook rejected; host cannot yet forward non-200 status/body",
      expect.objectContaining({ status: 401 })
    );
  });

  it("logs an error, does not invoke the agent, and rejects (so the host does not ack success) when companyId cannot be resolved", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev002",
      authorizations: [{ team_id: "T111" }],
      event: { type: "app_mention" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const ctx = makeCtx({
      agents: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => null), // no company has this agent
        invoke: vi.fn(async () => ({ runId: "run-1" })),
      },
    });

    await expect(
      handleSlackProviderWebhook(
        {
          endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
          headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
          rawBody,
          requestId: "req-3",
        },
        ctx as never
      )
    ).rejects.toThrow(/companyId/i);

    expect(ctx.agents.invoke).not.toHaveBeenCalled();
    expect(ctx.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/companyId/i),
      expect.objectContaining({ agentId: "agent-1" })
    );
  });

  it("rejects (so the host does not ack success) when the routed agent invocation itself fails", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev003",
      authorizations: [{ team_id: "T111" }],
      event: { type: "app_mention" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const invokeError = new Error("agent runtime unavailable");
    const ctx = makeCtx({
      agents: {
        list: vi.fn(async () => []),
        get: vi.fn(async (agentId: string, companyId: string) =>
          agentId === "agent-1" && companyId === "co-1" ? { id: agentId, companyId } : null
        ),
        invoke: vi.fn(async () => {
          throw invokeError;
        }),
      },
    });

    await expect(
      handleSlackProviderWebhook(
        {
          endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
          headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
          rawBody,
          requestId: "req-5",
        },
        ctx as never
      )
    ).rejects.toThrow(invokeError);

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Slack webhook: failed to invoke routed agent",
      expect.objectContaining({ agentId: "agent-1", reason: invokeError.message })
    );
  });

  it("rejects retryably with a sanitized error when signing-secret resolution is transiently unavailable", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-secret-outage",
      authorizations: [{ team_id: "T111" }],
      event: { type: "app_mention" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const ctx = makeCtx({
      secrets: {
        resolve: vi.fn(async () => {
          throw new Error("vault backend outage at secret/internal/path");
        }),
      },
    });

    let failure: unknown;
    try {
      await handleSlackProviderWebhook(
        {
          endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
          headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
          rawBody,
          requestId: "req-secret-outage",
        },
        ctx as never,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/temporarily unavailable/i);
    expect((failure as Error).message).not.toContain("secret/internal/path");
    expect(ctx.agents.invoke).not.toHaveBeenCalled();
  });

  it("makes a concurrent duplicate share the routed invocation failure instead of acknowledging it early", async () => {
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-concurrent-failure",
      authorizations: [{ team_id: "T111" }],
      event: { type: "app_mention" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const invokeError = new Error("agent runtime unavailable");
    let signalInvokeStarted!: () => void;
    let rejectInvoke!: (reason: unknown) => void;
    const invokeStarted = new Promise<void>((resolve) => {
      signalInvokeStarted = resolve;
    });
    const ctx = makeCtx({
      agents: {
        list: vi.fn(async () => []),
        get: vi.fn(async (agentId: string, companyId: string) =>
          agentId === "agent-1" && companyId === "co-1" ? { id: agentId, companyId } : null
        ),
        invoke: vi.fn(() => new Promise((_resolve, reject) => {
          rejectInvoke = reject;
          signalInvokeStarted();
        })),
      },
    });
    const input = (requestId: string) => ({
      endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
      rawBody,
      requestId,
    });

    const first = handleSlackProviderWebhook(input("req-concurrent-1"), ctx as never);
    await invokeStarted;
    const duplicate = handleSlackProviderWebhook(input("req-concurrent-2"), ctx as never);
    await vi.waitFor(() => expect(ctx.secrets.resolve).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    rejectInvoke(invokeError);

    const results = await Promise.allSettled([first, duplicate]);
    expect(results).toEqual([
      { status: "rejected", reason: invokeError },
      { status: "rejected", reason: invokeError },
    ]);
    expect(ctx.agents.invoke).toHaveBeenCalledTimes(1);
  });

  it("passes only a bounded, JSON-escaped Slack event projection to the agent", async () => {
    const text = `hello\n"quoted"${"x".repeat(5_000)}`;
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-bounded-prompt",
      authorizations: [{ team_id: "T111" }],
      event: {
        type: "app_mention",
        text,
        channel: "C".repeat(400),
        user: "U111",
        ts: "123.456",
        thread_ts: "123.000",
        arbitrary: "DO_NOT_INCLUDE_THIS_MARKER",
      },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const ctx = makeCtx();

    await handleSlackProviderWebhook(
      {
        endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
        rawBody,
        requestId: "req-bounded-prompt",
      },
      ctx as never,
    );

    const invocation = (
      ctx.agents.invoke.mock.calls as unknown as Array<[string, string, { prompt: string }]>
    )[0][2];
    const prefix = "Slack event received:\n";
    expect(invocation.prompt.startsWith(prefix)).toBe(true);
    expect(invocation.prompt).not.toContain("DO_NOT_INCLUDE_THIS_MARKER");
    expect(invocation.prompt).toContain("\\n\\\"quoted\\\"");
    const projected = JSON.parse(invocation.prompt.slice(prefix.length)) as {
      eventId: string;
      teamId: string;
      appId: string;
      event: Record<string, string>;
    };
    expect(projected.eventId).toBe("Ev-bounded-prompt");
    expect(projected.teamId).toBe("T111");
    expect(projected.appId).toBe("A111");
    expect(projected.event.text).toBe(text.slice(0, 4_096));
    expect(projected.event.channel).toHaveLength(256);
    expect(Object.keys(projected.event)).toEqual(["type", "text", "channel", "user", "ts", "thread_ts"]);
  });

  it("responds to the url_verification handshake without touching agents/companies", async () => {
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "chal-1" });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const ctx = makeCtx();

    await handleSlackProviderWebhook(
      {
        endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": sign(timestamp, rawBody) },
        rawBody,
        requestId: "req-4",
      },
      ctx as never
    );

    expect(ctx.agents.invoke).not.toHaveBeenCalled();
    expect(ctx.companies.list).not.toHaveBeenCalled();
  });
});
