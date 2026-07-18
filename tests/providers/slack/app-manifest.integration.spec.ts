import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../../src/manifest.js";
import plugin from "../../../src/worker.js";
import { CONFIG_SCOPE } from "../../../src/config-source.js";
import { BOT_IDENTITY_SETTINGS_VERSION } from "../../../src/core/identity-config.js";
import type {
  BotIdentitySettingsData,
  CreateSlackAppManifestResult,
  DiscoverSlackInstallMetadataResult,
  GetSlackAppManifestFlowResult,
  SaveSlackInstallMetadataResult,
} from "../../../src/shared/types.js";

const COMPANY_A = "00000000-0000-4000-8000-0000000000a1";
const COMPANY_B = "00000000-0000-4000-8000-0000000000b1";
const EVENTS_REQUEST_URL = "https://paperclip-test.trycloudflare.com/events";
const FAKE_SECRET_ID = "00000000-0000-4000-8000-000000000010";
const FAKE_SECRET_ID_2 = "00000000-0000-4000-8000-000000000011";
const FAKE_SIGNING_SECRET_ID = "00000000-0000-4000-8000-000000000012";

const PRESERVED_COMPANY_IDENTITY = {
  label: "Preserved GitHub identity",
  githubUsername: "preserved-user",
};

function harnessWithSetup() {
  const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
  let companyConfig: Record<string, unknown> = {
    identities: { "agent-preserved": PRESERVED_COMPANY_IDENTITY },
  };
  const getCompanyConfig = () => structuredClone(companyConfig);
  const getConfig = vi.fn(async (companyId?: string) =>
    companyId === COMPANY_A ? getCompanyConfig() : { identities: {} }
  );
  const patchSecretRefs = vi.fn(async (input: {
    companyId?: string;
    path: string[];
    value: Record<string, unknown> | null;
  }) => {
    if (input.companyId !== COMPANY_A) throw new Error("Unexpected company scope.");
    if (input.path.length !== 2 || input.path[0] !== "identities" || !input.path[1]) {
      throw new Error("Test harness only supports identity-subtree config patches.");
    }
    const currentIdentities = typeof companyConfig.identities === "object" && companyConfig.identities !== null
      ? { ...companyConfig.identities as Record<string, unknown> }
      : {};
    if (input.value === null) {
      delete currentIdentities[input.path[1]];
    } else {
      currentIdentities[input.path[1]] = structuredClone(input.value);
    }
    companyConfig = { ...companyConfig, identities: currentIdentities };
  });
  Object.assign(harness.ctx.config, { get: getConfig, patchSecretRefs });
  harness.seed({
    agents: [
      ...[
        "agent-slack-1",
        "agent-cancelled",
        "agent-expiring",
        "agent-original",
        "agent-other",
        "agent-cross-company",
        "agent-log-check",
      ].map((id) => ({ id, name: id, companyId: COMPANY_A } as never)),
      { id: "agent-in-other-company", name: "agent-in-other-company", companyId: COMPANY_B } as never,
    ],
  });
  return Object.assign(harness, { getCompanyConfig, getConfig, patchSecretRefs });
}

describe("Slack manifest-assisted app setup actions", () => {
  it("completes create -> get -> save end-to-end without ever returning a secret value", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Sterling Hale", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    expect(created.agentId).toBe("agent-slack-1");
    expect(created.provider).toBe("slack");
    expect(created.createAppUrl).toBe("https://api.slack.com/apps?new_app=1");
    expect(created.createAppUrl).not.toContain("manifest_json");
    expect(created.eventsRequestUrl).toBe(EVENTS_REQUEST_URL);
    const manifestBody = JSON.parse(created.manifest);
    expect(manifestBody.features.app_home).toEqual({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifestBody.features.agent_view).toEqual({
      agent_description: "Paperclip agent identity for Sterling Hale",
    });
    expect(manifestBody.features.assistant_view).toBeUndefined();
    expect(manifestBody.settings.event_subscriptions).toEqual({
      request_url: EVENTS_REQUEST_URL,
      bot_events: [
        "app_home_opened",
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
      ],
    });
    expect(manifestBody.oauth_config.scopes.bot).toEqual([
      "assistant:write",
      "app_mentions:read",
      "chat:write",
      "channels:history",
      "channels:read",
      "groups:history",
      "groups:read",
      "im:history",
      "mpim:history",
      "reactions:write",
      "users:read",
    ]);

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
        defaultChannel: "D0123ABCD",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );

    expect(saved).toEqual({
      agentId: "agent-slack-1",
      provider: "slack",
      teamId: "T0123ABCD",
      appId: "A0123ABCD",
      botUserId: "U0123ABCD",
      botTokenSecretId: FAKE_SECRET_ID,
      signingSecretId: FAKE_SIGNING_SECRET_ID,
      defaultChannel: "D0123ABCD",
      status: "saved",
    });

    // Public identity config persisted (shareable fields only).
    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config", { companyId: COMPANY_A });
    const entry = settings.identities.find((identity) => identity.agentId === "agent-slack-1");
    expect(entry?.provider === "slack" && entry.slack).toEqual({
      teamId: "T0123ABCD",
      appId: "A0123ABCD",
      botUserId: "U0123ABCD",
      defaultChannel: "D0123ABCD",
    });
    expect(entry?.credentialStatus).toBe("configured");
    expect(entry?.slackSetup).toEqual({
      eventsRequestUrl: EVENTS_REQUEST_URL,
      botTokenSecretId: FAKE_SECRET_ID,
      signingSecretId: FAKE_SIGNING_SECRET_ID,
    });

    const expectedIdentityConfig = {
      label: "Sterling Hale",
      teamId: "T0123ABCD",
      appId: "A0123ABCD",
      botUserId: "U0123ABCD",
      defaultChannel: "D0123ABCD",
      eventsRequestUrl: EVENTS_REQUEST_URL,
      credentials: {
        botToken: {
          type: "secret_ref",
          secretId: FAKE_SECRET_ID,
          version: "latest",
        },
        signingSecret: {
          type: "secret_ref",
          secretId: FAKE_SIGNING_SECRET_ID,
          version: "latest",
        },
      },
    };
    expect(harness.patchSecretRefs).toHaveBeenCalledOnce();
    expect(harness.patchSecretRefs).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      path: ["identities", "agent-slack-1"],
      value: expectedIdentityConfig,
    });
    expect(harness.getCompanyConfig()).toEqual({
      identities: {
        "agent-preserved": PRESERVED_COMPANY_IDENTITY,
        "agent-slack-1": expectedIdentityConfig,
      },
    });

    // No secret-shaped value anywhere in the returned payloads.
    const serializedPayloads = JSON.stringify({
      created,
      fetched,
      saved,
      settings,
      companyConfig: harness.getCompanyConfig(),
    });
    expect(serializedPayloads).not.toMatch(/xox[bp]-/);
    expect(serializedPayloads).not.toContain("resolved:");

    // Single-use: the flow is now consumed and cannot be replayed.
    await expect(harness.performAction<GetSlackAppManifestFlowResult>(
      "get-slack-app-manifest-flow",
      { state: created.state },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/expired|used|Unknown/);
  });

  it("discovers workspace, app, and bot IDs through a temporary exact secret binding and always removes it", async () => {
    const harness = harnessWithSetup();
    const patchSecretRefs = vi.fn(async (_input: {
      companyId?: string;
      path: string[];
      value: Record<string, unknown> | null;
    }) => undefined);
    const resolve = vi.fn(async (_ref: unknown, _options: unknown) => "xoxb-test-secret-value");
    Object.assign(harness.ctx.config, { patchSecretRefs });
    Object.assign(harness.ctx.secrets, { resolve });
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth.test")) {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T0123ABCD",
          user_id: "U0123ABCD",
          bot_id: "B0123ABCD",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/bots.info")) {
        return new Response(JSON.stringify({
          ok: true,
          bot: { app_id: "A0123ABCD" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected Slack API URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await plugin.definition.setup(harness.ctx);
      const result = await harness.performAction<DiscoverSlackInstallMetadataResult>(
        "discover-slack-install-metadata",
        { botTokenSecretId: FAKE_SECRET_ID },
        { companyId: COMPANY_A },
      );

      expect(result).toEqual({ teamId: "T0123ABCD", appId: "A0123ABCD", botUserId: "U0123ABCD" });
      expect(JSON.stringify(result)).not.toContain("xoxb-");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toBe("https://slack.com/api/bots.info");
      const botsInfoInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
      expect(botsInfoInit.headers).toEqual({
        Authorization: "Bearer xoxb-test-secret-value",
        "Content-Type": "application/x-www-form-urlencoded",
      });
      expect(String(botsInfoInit.body)).toBe("bot=B0123ABCD");
      expect(patchSecretRefs).toHaveBeenCalledTimes(2);
      const setupCall = patchSecretRefs.mock.calls[0]?.[0] as {
        companyId: string;
        path: string[];
        value: { botToken: { type: string; secretId: string; version: string } };
      };
      expect(setupCall.companyId).toBe(COMPANY_A);
      expect(setupCall.path).toEqual(["setup", "slack", "metadata", expect.stringMatching(/^[0-9a-f]{32}$/)]);
      expect(setupCall.value).toEqual({
        botToken: { type: "secret_ref", secretId: FAKE_SECRET_ID, version: "latest" },
      });
      expect(resolve).toHaveBeenCalledWith(setupCall.value.botToken, {
        companyId: COMPANY_A,
        configPath: `${setupCall.path.join(".")}.botToken`,
      });
      expect(patchSecretRefs.mock.calls[1]?.[0]).toEqual({
        companyId: COMPANY_A,
        path: setupCall.path,
        value: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never persists anything when the flow is only created and never saved (cancellation)", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-cancelled", label: "Cancelled Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
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
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/Unknown or expired/);
  });

  it("rejects an expired flow state", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-expiring", label: "Expiring Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    // Force expiry by rewriting the in-memory state's expiresAt to the past.
    const scope = { scopeKind: "company" as const, scopeId: COMPANY_A, stateKey: `slack-app-manifest-flow:${created.state}` };
    const stored = harness.getState(scope) as Record<string, unknown>;
    await harness.ctx.state.set(scope, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });

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
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/expired/);
  });

  it("rejects replay of a consumed state (cannot overwrite another agent)", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-original", label: "Original Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
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
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );

    // Replaying the same state — even for the SAME agent — must fail (single
    // use). A successfully-saved flow is now deleted outright (not merely
    // marked consumed) to avoid retaining flow state indefinitely, so the
    // replay is rejected as "unknown" rather than "already used" — either way
    // it is not re-processed and does not overwrite the identity.
    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-original",
        teamId: "T2",
        appId: "A2",
        botUserId: "U2",
        botTokenSecretId: FAKE_SECRET_ID_2,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/unknown|expired/i);

    // Replaying against a DIFFERENT agent must also fail, and must not
    // overwrite that other agent's identity.
    const createdOther = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-other", label: "Other Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
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
        signingSecretId: FAKE_SIGNING_SECRET_ID,
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
      { agentId: "agent-cross-company", label: "Cross Company Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
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
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_B },
    )).rejects.toThrow(/Unknown or expired/);
  });

  it("requires a host-authorized companyId to create a flow", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-no-company", label: "No Company Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
    )).rejects.toThrow(/companyId/);
  });

  it("never logs a resolved secret value, only the secret reference", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-log-check", label: "Log Check Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
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
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );

    // Logs must never contain a raw Slack token pattern, and must never
    // contain a resolved-secret marker — only (optionally) the opaque secret
    // UUID reference itself is acceptable, never a "resolved" value.
    const serializedLogs = JSON.stringify(harness.logs);
    expect(serializedLogs).not.toMatch(/xox[bp]-/);
    expect(serializedLogs).not.toContain("resolved:");
    // The one-time setup `state` is short-lived secret material and must
    // never be logged either.
    expect(serializedLogs).not.toContain(created.state);
  });

  it("ignores a caller-supplied companyId in params and only trusts the host-authorized context", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    // The host authorizes COMPANY_A via the trusted `options.companyId`, but
    // the caller also smuggles a *different* company id inside `params`.
    // The action must use the host-authorized COMPANY_A (where
    // "agent-slack-1" actually belongs), not the spoofed `params.companyId`
    // — proven here by the create succeeding rather than failing with a
    // cross-company "does not belong" error.
    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Spoofed Bot", eventsRequestUrl: EVENTS_REQUEST_URL, companyId: COMPANY_B },
      { companyId: COMPANY_A },
    );
    expect(created.agentId).toBe("agent-slack-1");
  });

  it("rejects creating a flow for an agentId that does not belong to the authorized company", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-in-other-company", label: "Foreign Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/does not belong/);
  });

  it("rejects a non-UUID botTokenSecretId atomically, before any state mutation", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Bad Secret Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: "not-a-uuid",
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/UUID/);

    // Nothing should have been persisted, and the flow must still be usable
    // (not consumed) since the request failed validation before any mutation.
    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(settings.identities.find((identity) => identity.agentId === "agent-slack-1")).toBeUndefined();

    const retried = await harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );
    expect(retried.status).toBe("saved");
  });

  it("rejects a non-UUID signingSecretId atomically, before any state mutation", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Bad Signing Secret Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: "not-a-uuid",
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/signingSecretId.*UUID/);

    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(settings.identities.find((identity) => identity.agentId === "agent-slack-1")).toBeUndefined();

    const retried = await harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );
    expect(retried.status).toBe("saved");
  });

  it("truncates manifest display_information.name/description for an overlong label without truncating the stored label", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const longLabel = "A".repeat(200);
    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: longLabel, eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    // The full label is retained in flow state...
    expect(created.label).toBe(longLabel);
    // ...but the manifest's Slack-facing display fields are truncated to
    // their documented limits.
    const manifestBody = JSON.parse(created.manifest);
    expect(manifestBody.display_information.name.length).toBeLessThanOrEqual(35);
    expect(manifestBody.features.bot_user.display_name.length).toBeLessThanOrEqual(80);
    expect(manifestBody.display_information.description.length).toBeLessThanOrEqual(100);
  });

  it("rejects a defaultChannel that does not match the Slack channel ID pattern", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Bad Channel Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        defaultChannel: "general",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/defaultChannel/);

    // Nothing persisted, and the flow must still be usable (rejected before
    // any mutation).
    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(settings.identities.find((identity) => identity.agentId === "agent-slack-1")).toBeUndefined();
  });

  it("rejects save when the agent has moved out of the host-authorized company since the flow was created", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Moving Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    // Simulate the agent moving to another company during the flow's TTL
    // window (membership was valid at create time, but not anymore).
    harness.seed({ agents: [{ id: "agent-slack-1", name: "agent-slack-1", companyId: COMPANY_B } as never] });

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/does not belong/);

    // The flow must not have been left consumed by the rejected save, and no
    // identity metadata should have been persisted.
    const settings = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(settings.identities.find((identity) => identity.agentId === "agent-slack-1")).toBeUndefined();
  });

  it("rolls back only the selected CONFIG_SCOPE identity and un-consumes the flow when the atomic config patch fails", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const previousSelectedIdentity = {
      provider: "slack" as const,
      id: "agent-slack-1:slack",
      agentId: "agent-slack-1",
      label: "Previous Slack identity",
      slack: { teamId: "TOLD", appId: "AOLD", botUserId: "UOLD" },
    };
    const unrelatedIdentity = {
      provider: "slack" as const,
      id: "agent-other:slack",
      agentId: "agent-other",
      label: "Unrelated Slack identity",
      slack: { teamId: "TOTHER", appId: "AOTHER", botUserId: "UOTHER" },
    };
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: BOT_IDENTITY_SETTINGS_VERSION,
      identities: {
        [previousSelectedIdentity.id]: previousSelectedIdentity,
        [unrelatedIdentity.id]: unrelatedIdentity,
      },
    });

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Config Patch Failure Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    harness.patchSecretRefs.mockRejectedValueOnce(new Error("atomic config patch failed"));

    await expect(harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    )).rejects.toThrow();

    expect(harness.getState(CONFIG_SCOPE)).toEqual({
      version: BOT_IDENTITY_SETTINGS_VERSION,
      identities: {
        [previousSelectedIdentity.id]: previousSelectedIdentity,
        [unrelatedIdentity.id]: unrelatedIdentity,
      },
    });
    expect(harness.getCompanyConfig()).toEqual({
      identities: { "agent-preserved": PRESERVED_COMPANY_IDENTITY },
    });

    // Retry the exact same state after the one-shot host failure. Success
    // proves the flow was reopened, and the unrelated settings identity must
    // remain untouched.
    const retried = await harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "T1",
        appId: "A1",
        botUserId: "U1",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );
    expect(retried.status).toBe("saved");
    const settingsAfterRetry = harness.getState(CONFIG_SCOPE) as {
      identities: Record<string, { label: string }>;
    };
    expect(settingsAfterRetry.identities["agent-slack-1:slack"].label).toBe("Config Patch Failure Bot");
    expect(settingsAfterRetry.identities["agent-other:slack"]).toEqual(unrelatedIdentity);
  });
});
