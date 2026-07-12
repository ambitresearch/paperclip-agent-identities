import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../../src/manifest.js";
import plugin from "../../../src/worker.js";
import { CREDENTIAL_SIDECAR_PATH_ENV } from "../../../src/credential-sidecar.js";
import type {
  BotIdentitySettingsData,
  CreateSlackAppManifestResult,
  GetSlackAppManifestFlowResult,
  SaveSlackInstallMetadataResult,
} from "../../../src/shared/types.js";

const COMPANY_A = "00000000-0000-4000-8000-0000000000a1";
const COMPANY_B = "00000000-0000-4000-8000-0000000000b1";
const FAKE_SECRET_ID = "00000000-0000-4000-8000-000000000010";
const FAKE_SECRET_ID_2 = "00000000-0000-4000-8000-000000000011";

let credentialSidecarDir: string | null = null;
const originalCredentialSidecarPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];

beforeEach(async () => {
  credentialSidecarDir = await mkdtemp(join(tmpdir(), "agent-identities-slack-manifest-test-"));
  process.env[CREDENTIAL_SIDECAR_PATH_ENV] = join(credentialSidecarDir, "credentials.json");
});

afterEach(async () => {
  if (originalCredentialSidecarPath === undefined) {
    delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  } else {
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalCredentialSidecarPath;
  }
  if (credentialSidecarDir) {
    await rm(credentialSidecarDir, { recursive: true, force: true });
    credentialSidecarDir = null;
  }
});

function harnessWithSetup() {
  const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
  return harness;
}

describe("Slack manifest-assisted app setup actions", () => {
  it("completes create -> get -> save end-to-end without ever returning a secret value", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Sterling Hale" },
      { companyId: COMPANY_A },
    );

    expect(created.agentId).toBe("agent-slack-1");
    expect(created.provider).toBe("slack");
    expect(created.deepLink).toContain("https://api.slack.com/apps?new_app=1&manifest_json=");
    const manifestBody = JSON.parse(created.manifest);
    expect(manifestBody.settings.event_subscriptions).toBeUndefined();
    expect(manifestBody.oauth_config.scopes.bot).toEqual(["chat:write", "channels:read", "groups:read", "reactions:write"]);

    const fetched = await harness.performAction<GetSlackAppManifestFlowResult>(
      "get-slack-app-manifest-flow",
      { state: created.state },
      { companyId: COMPANY_A },
    );
    expect(fetched).toEqual(created);

    const saved = await harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T0123ABCD",
        appId: "A0123ABCD",
        botUserId: "U0123ABCD",
        defaultChannel: "C0123ABCD",
        botTokenSecretId: FAKE_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );

    expect(saved).toEqual({
      agentId: "agent-slack-1",
      provider: "slack",
      teamId: "T0123ABCD",
      appId: "A0123ABCD",
      botUserId: "U0123ABCD",
      defaultChannel: "C0123ABCD",
      status: "saved",
    });

    // Public identity config persisted (shareable fields only).
    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    const entry = settings.identities.find((identity) => identity.agentId === "agent-slack-1");
    expect(entry?.provider === "slack" && entry.slack).toEqual({
      teamId: "T0123ABCD",
      appId: "A0123ABCD",
      botUserId: "U0123ABCD",
      defaultChannel: "C0123ABCD",
    });
    expect(entry?.credentialStatus).toBe("configured");

    // Credential sidecar stores only the secret reference, never a resolved token.
    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-slack-1:slack"]).toEqual({
      slackBotToken: { botTokenSecretId: FAKE_SECRET_ID },
    });

    // No secret-shaped value anywhere in the returned payloads.
    const serializedPayloads = JSON.stringify({ created, fetched, saved, settings, sidecar });
    expect(serializedPayloads).not.toMatch(/xox[bp]-/);
    expect(serializedPayloads).not.toContain("resolved:");

    // Single-use: the flow is now consumed and cannot be replayed.
    await expect(harness.performAction<GetSlackAppManifestFlowResult>(
      "get-slack-app-manifest-flow",
      { state: created.state },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/expired|used|Unknown/);
  });

  it("never persists anything when the flow is only created and never saved (cancellation)", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-cancelled", label: "Cancelled Bot" },
      { companyId: COMPANY_A },
    );

    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(settings.identities.find((identity) => identity.agentId === "agent-cancelled")).toBeUndefined();
  });

  it("rejects save-slack-install-metadata with a state that does not match any flow", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: "pc_does_not_exist",
        agentId: "agent-x",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/Unknown or expired/);
  });

  it("rejects an expired flow state", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-expiring", label: "Expiring Bot" },
      { companyId: COMPANY_A },
    );

    // Force expiry by rewriting the in-memory state's expiresAt to the past.
    const scope = { scopeKind: "company" as const, scopeId: COMPANY_A, stateKey: `slack-app-manifest-flow:${created.state}` };
    const stored = harness.getState(scope) as Record<string, unknown>;
    harness.ctx.state.set(scope, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });

    await expect(harness.performAction<GetSlackAppManifestFlowResult>(
      "get-slack-app-manifest-flow",
      { state: created.state },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/expired/);

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-expiring",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/expired/);
  });

  it("rejects replay of a consumed state (cannot overwrite another agent)", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-original", label: "Original Bot" },
      { companyId: COMPANY_A },
    );

    await harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-original",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );

    // Replaying the same state — even for the SAME agent — must fail (single use).
    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-original",
        teamId: "T2",
        appId: "A2",
        botUserId: "U2",
        botTokenSecretId: FAKE_SECRET_ID_2,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/used/);

    // Replaying against a DIFFERENT agent must also fail, and must not
    // overwrite that other agent's identity.
    const createdOther = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-other", label: "Other Bot" },
      { companyId: COMPANY_A },
    );
    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: createdOther.state,
        agentId: "agent-original",
        teamId: "T3",
        appId: "A3",
        botUserId: "U3",
        botTokenSecretId: FAKE_SECRET_ID_2,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/does not match/);

    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    const original = settings.identities.find((identity) => identity.agentId === "agent-original");
    expect(original?.provider === "slack" && original.slack.teamId).toBe("T1");
    const other = settings.identities.find((identity) => identity.agentId === "agent-other");
    expect(other).toBeUndefined();
  });

  it("rejects a flow looked up or saved under the wrong company (workspace/company mismatch)", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-cross-company", label: "Cross Company Bot" },
      { companyId: COMPANY_A },
    );

    await expect(harness.performAction<GetSlackAppManifestFlowResult>(
      "get-slack-app-manifest-flow",
      { state: created.state },
      { companyId: COMPANY_B },
    )).rejects.toThrow(/Unknown or expired/);

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-cross-company",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
      },
      { companyId: COMPANY_B },
    )).rejects.toThrow(/Unknown or expired/);
  });

  it("requires a host-authorized companyId to create a flow", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-no-company", label: "No Company Bot" },
    )).rejects.toThrow(/companyId/);
  });

  it("never logs a resolved secret value, only the secret reference", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-log-check", label: "Log Check Bot" },
      { companyId: COMPANY_A },
    );
    await harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-log-check",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );

    // Logs must never contain a raw Slack token pattern, and must never
    // contain a resolved-secret marker — only (optionally) the opaque secret
    // UUID reference itself is acceptable, never a "resolved" value.
    const serializedLogs = JSON.stringify(harness.logs);
    expect(serializedLogs).not.toMatch(/xox[bp]-/);
    expect(serializedLogs).not.toContain("resolved:");
  });
});
