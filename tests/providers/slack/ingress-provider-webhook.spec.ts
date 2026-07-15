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

  return {
    state: {
      get: vi.fn(async (key: { stateKey: string }) => {
        if (key.stateKey === CONFIG_SCOPE.stateKey) return settingsState;
        return null;
      }),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
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

  it("does not invoke any agent when the signature is invalid, and returns without throwing", async () => {
    const payload = { type: "event_callback", team_id: "T111", api_app_id: "A111", event: {} };
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
