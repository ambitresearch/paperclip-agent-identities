import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../../src/manifest.js";
import plugin from "../../../src/worker.js";
import { CREDENTIAL_SIDECAR_PATH_ENV, upsertCredentialSidecarIdentity } from "../../../src/credential-sidecar.js";
import { CONFIG_SCOPE } from "../../../src/config-source.js";
import { BOT_IDENTITY_SETTINGS_VERSION } from "../../../src/core/identity-config.js";

// End-to-end coverage that DRO-975's Slack HTTP Events API ingress is
// actually wired into the plugin's manifest + worker seams -- not just
// unit-tested in isolation. Exercises the real `onWebhook` hook through the
// generic provider-registry `webhooks()`/`handleWebhook` dispatch (see
// src/core/provider-registry.ts, src/providers/slack/ingress/provider-webhook.ts).

const SIGNING_SECRET_ID = "00000000-0000-4000-8000-000000000099";

function sign(secret: string, timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", secret).update(base, "utf8").digest("hex");
  return `v0=${hmac}`;
}

describe("Slack Events API ingress — manifest + worker wiring", () => {
  const originalPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "slack-ingress-worker-"));
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = join(directory, "credentials.json");
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  it("advertises the slack-events webhook endpoint in the manifest via the generic registry seam", () => {
    expect(manifest.webhooks).toEqual([
      expect.objectContaining({ endpointKey: "slack-events", displayName: "Slack Events API" }),
    ]);
  });

  it("declares webhooks.receive and agents.invoke capabilities required for ingress", () => {
    expect(manifest.capabilities).toContain("webhooks.receive");
    expect(manifest.capabilities).toContain("agents.invoke");
  });

  it("routes a signed event_callback delivery to the matching agent end-to-end", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    harness.seed({
      companies: [{ id: "company-1", name: "Acme" } as never],
      agents: [{ id: "agent-1", companyId: "company-1", name: "Agent One", status: "idle" } as never],
    });

    // Slack install metadata lives in settings state (public, non-secret);
    // the signing secret reference lives only in the credential sidecar.
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: BOT_IDENTITY_SETTINGS_VERSION,
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Agent One",
          slack: { teamId: "T111", appId: "A111", botUserId: "U111" },
        },
      },
    });
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000010", signingSecretId: SIGNING_SECRET_ID },
    });

    await plugin.definition.setup(harness.ctx);
    const invokeSpy = vi.spyOn(harness.ctx.agents, "invoke");

    // The test harness resolves any secret ref to `resolved:${ref}` (see
    // @paperclipai/plugin-sdk/testing), so the "real" signing secret value
    // used to sign this request is that same deterministic string.
    const signingSecret = `resolved:${SIGNING_SECRET_ID}`;
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
    const signature = sign(signingSecret, timestamp, rawBody);

    await plugin.definition.onWebhook?.({
      endpointKey: "slack-events",
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      rawBody,
      requestId: "req-1",
    });

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith(
      "agent-1",
      "company-1",
      expect.objectContaining({ reason: "slack-inbound-event" })
    );
  });

  it("does not dispatch anything for an unknown endpointKey", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);
    const invokeSpy = vi.spyOn(harness.ctx.agents, "invoke");

    await plugin.definition.onWebhook?.({
      endpointKey: "not-a-real-endpoint",
      headers: {},
      rawBody: "{}",
      requestId: "req-2",
    });

    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("acks an invalid signature end-to-end without invoking any agent", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    harness.seed({
      companies: [{ id: "company-1", name: "Acme" } as never],
      agents: [{ id: "agent-1", companyId: "company-1", name: "Agent One", status: "idle" } as never],
    });
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: BOT_IDENTITY_SETTINGS_VERSION,
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Agent One",
          slack: { teamId: "T111", appId: "A111", botUserId: "U111" },
        },
      },
    });
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000010", signingSecretId: SIGNING_SECRET_ID },
    });

    await plugin.definition.setup(harness.ctx);
    const invokeSpy = vi.spyOn(harness.ctx.agents, "invoke");

    const payload = { type: "event_callback", team_id: "T111", api_app_id: "A111", event_id: "Ev002", event: {} };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));

    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: "slack-events",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=deadbeef" },
        rawBody,
        requestId: "req-3",
      })
    ).resolves.toBeUndefined();

    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("releases the dedup claim when agent invocation fails, so a Slack retry of the same event_id can succeed later", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    harness.seed({
      companies: [{ id: "company-1", name: "Acme" } as never],
      agents: [{ id: "agent-1", companyId: "company-1", name: "Agent One", status: "idle" } as never],
    });
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: BOT_IDENTITY_SETTINGS_VERSION,
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Agent One",
          slack: { teamId: "T111", appId: "A111", botUserId: "U111" },
        },
      },
    });
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000010", signingSecretId: SIGNING_SECRET_ID },
    });

    await plugin.definition.setup(harness.ctx);

    const signingSecret = `resolved:${SIGNING_SECRET_ID}`;
    const payload = {
      type: "event_callback",
      team_id: "T111",
      api_app_id: "A111",
      event_id: "Ev-retry-after-failure",
      authorizations: [{ team_id: "T111" }],
      event: { type: "app_mention", text: "hello" },
    };
    const rawBody = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(signingSecret, timestamp, rawBody);

    // First delivery: agent invocation fails.
    const invokeSpy = vi
      .spyOn(harness.ctx.agents, "invoke")
      .mockRejectedValueOnce(new Error("agent runtime unavailable"));

    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: "slack-events",
        headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
        rawBody,
        requestId: "req-fail-1",
      })
    ).rejects.toThrow("agent runtime unavailable");

    expect(invokeSpy).toHaveBeenCalledTimes(1);

    // Slack redelivers the identical event_id (its own retry policy for a
    // failed/slow ack). Because the failed first attempt released its dedup
    // claim, this second delivery must be allowed to actually invoke the
    // agent again -- not be silently dropped as a duplicate.
    invokeSpy.mockResolvedValueOnce(undefined as never);
    await plugin.definition.onWebhook?.({
      endpointKey: "slack-events",
      headers: { "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
      rawBody,
      requestId: "req-fail-2",
    });

    expect(invokeSpy).toHaveBeenCalledTimes(2);
  });
});
