import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsActionTestHarness as createTestHarness } from "../../helpers/settings-action-harness.js";
import manifest from "../../../src/manifest.js";
import plugin from "../../../src/worker.js";
import { CONFIG_SCOPE } from "../../../src/config-source.js";
import { BOT_IDENTITY_SETTINGS_VERSION } from "../../../src/core/identity-config.js";
import { CREDENTIAL_SIDECAR_PATH_ENV } from "../../../src/credential-sidecar.js";
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const PRESERVED_COMPANY_IDENTITY = {
  label: "Preserved GitHub identity",
  githubUsername: "preserved-user",
};

function harnessWithSetup() {
  const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
  let companyConfig: Record<string, unknown> = {
    identities: {
      "agent-preserved": PRESERVED_COMPANY_IDENTITY,
      "agent-slack-1": {
        label: "Preserved GitHub identity for shared agent",
        githubUsername: "shared-agent[bot]",
      },
    },
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
    if (input.path.length < 2 || input.path.length > 3 || input.path[0] !== "identities" || !input.path[1]) {
      throw new Error("Test harness only supports identity-subtree config patches.");
    }
    const currentIdentities = typeof companyConfig.identities === "object" && companyConfig.identities !== null
      ? { ...companyConfig.identities as Record<string, unknown> }
      : {};
    const agentId = input.path[1];
    if (input.path.length === 3) {
      const currentIdentity = typeof currentIdentities[agentId] === "object" && currentIdentities[agentId] !== null
        ? { ...currentIdentities[agentId] as Record<string, unknown> }
        : {};
      const provider = input.path[2];
      if (input.value === null) delete currentIdentity[provider];
      else currentIdentity[provider] = structuredClone(input.value);
      currentIdentities[agentId] = currentIdentity;
    } else if (input.value === null) {
      delete currentIdentities[agentId];
    } else {
      currentIdentities[agentId] = structuredClone(input.value);
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
      eventsRequestUrl: EVENTS_REQUEST_URL,
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
      path: ["identities", "agent-slack-1", "slack"],
      value: expectedIdentityConfig,
    });
    expect(harness.getCompanyConfig()).toEqual({
      identities: {
        "agent-preserved": PRESERVED_COMPANY_IDENTITY,
        "agent-slack-1": {
          label: "Preserved GitHub identity for shared agent",
          githubUsername: "shared-agent[bot]",
          slack: expectedIdentityConfig,
        },
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

  it("preserves a stale setup marker when config cleanup fails so the next discovery can retry", async () => {
    const harness = harnessWithSetup();
    const setupBindingScope = {
      scopeKind: "company" as const,
      scopeId: COMPANY_A,
      namespace: "slack-setup-bindings",
      stateKey: `metadata:${FAKE_SECRET_ID}`,
    };
    const stalePath = ["setup", "slack", "metadata", "0123456789abcdef0123456789abcdef"];
    await harness.ctx.state.set(setupBindingScope, { path: stalePath });
    harness.patchSecretRefs.mockRejectedValueOnce(new Error("stale cleanup failed"));
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction(
      "discover-slack-install-metadata",
      { botTokenSecretId: FAKE_SECRET_ID },
      { companyId: COMPANY_A },
    )).rejects.toThrow("stale cleanup failed");

    expect(harness.patchSecretRefs).toHaveBeenCalledOnce();
    expect(harness.patchSecretRefs).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      path: stalePath,
      value: null,
    });
    expect(harness.getState(setupBindingScope)).toEqual({ path: stalePath });
  });

  it("recovers an orphan setup marker when its secret binding was never created", async () => {
    const harness = harnessWithSetup();
    const setupBindingScope = {
      scopeKind: "company" as const,
      scopeId: COMPANY_A,
      namespace: "slack-setup-bindings",
      stateKey: `metadata:${FAKE_SECRET_ID}`,
    };
    const stalePath = ["setup", "slack", "metadata", "0123456789abcdef0123456789abcdef"];
    await harness.ctx.state.set(setupBindingScope, { path: stalePath });
    const patchSecretRefs = vi.fn(async (_input: {
      companyId?: string;
      path: string[];
      value: Record<string, unknown> | null;
    }) => undefined);
    patchSecretRefs.mockRejectedValueOnce(
      new Error("config.patchSecretRefs found no bound secret refs to remove"),
    );
    Object.assign(harness.ctx.config, { patchSecretRefs });
    Object.assign(harness.ctx.secrets, { resolve: vi.fn(async () => "xoxb-test-secret-value") });
    vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/auth.test")) {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T0123ABCD",
          user_id: "U0123ABCD",
          bot_id: "B0123ABCD",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, bot: { app_id: "A0123ABCD" } }), { status: 200 });
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction(
      "discover-slack-install-metadata",
      { botTokenSecretId: FAKE_SECRET_ID },
      { companyId: COMPANY_A },
    )).resolves.toEqual({ teamId: "T0123ABCD", appId: "A0123ABCD", botUserId: "U0123ABCD" });

    expect(patchSecretRefs).toHaveBeenCalledTimes(3);
    expect(patchSecretRefs.mock.calls[0]?.[0]).toEqual({
      companyId: COMPANY_A,
      path: stalePath,
      value: null,
    });
    expect(harness.getState(setupBindingScope)).toBeUndefined();
  });

  it("serializes concurrent metadata discovery for one company secret as addA/deleteA/addB/deleteB", async () => {
    const harness = harnessWithSetup();
    const releaseA = deferred();
    const aBound = deferred();
    const calls: string[] = [];
    let bindingNumber = 0;
    const patchSecretRefs = vi.fn(async (_input: {
      path: string[];
      value: Record<string, unknown> | null;
    }) => undefined);
    const activeBindings = new Set<string>();
    patchSecretRefs.mockImplementation(async (input) => {
      const path = input.path.join(".");
      if (input.value) {
        bindingNumber += 1;
        const owner = bindingNumber === 1 ? "A" : "B";
        calls.push(`add${owner}`);
        activeBindings.add(path);
        if (owner === "A") aBound.resolve();
      } else {
        calls.push(`delete${bindingNumber === 1 ? "A" : "B"}`);
        activeBindings.delete(path);
      }
    });
    const resolve = vi.fn(async () => {
      if (resolve.mock.calls.length === 1) await releaseA.promise;
      return "xoxb-test-secret-value";
    });
    Object.assign(harness.ctx.config, { patchSecretRefs });
    Object.assign(harness.ctx.secrets, { resolve });
    vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/auth.test")) {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T0123ABCD",
          user_id: "U0123ABCD",
          bot_id: "B0123ABCD",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, bot: { app_id: "A0123ABCD" } }), { status: 200 });
    });
    await plugin.definition.setup(harness.ctx);

    const requestA = harness.performAction(
      "discover-slack-install-metadata",
      { botTokenSecretId: FAKE_SECRET_ID },
      { companyId: COMPANY_A },
    );
    await aBound.promise;
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      namespace: "slack-setup-bindings",
      stateKey: `metadata:${FAKE_SECRET_ID}`,
    })).toEqual({
      version: 1,
      owner: expect.stringMatching(/^[0-9a-f]{32}$/),
      path: ["setup", "slack", "metadata", expect.stringMatching(/^[0-9a-f]{32}$/)],
    });
    const requestB = harness.performAction(
      "discover-slack-install-metadata",
      { botTokenSecretId: FAKE_SECRET_ID },
      { companyId: COMPANY_A },
    );
    await Promise.resolve();
    expect(calls).toEqual(["addA"]);

    releaseA.resolve();
    await Promise.all([requestA, requestB]);

    expect(calls).toEqual(["addA", "deleteA", "addB", "deleteB"]);
    expect(activeBindings).toEqual(new Set());
    expect(harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_A,
      namespace: "slack-setup-bindings",
      stateKey: `metadata:${FAKE_SECRET_ID}`,
    })).toBeUndefined();
  });

  it("does not delete a metadata marker after ownership changes", async () => {
    const harness = harnessWithSetup();
    const markerScope = {
      scopeKind: "company" as const,
      scopeId: COMPANY_A,
      namespace: "slack-setup-bindings",
      stateKey: `metadata:${FAKE_SECRET_ID}`,
    };
    const replacement = {
      version: 1,
      owner: "replacement-owner",
      path: ["setup", "slack", "metadata", "fedcba9876543210fedcba9876543210"],
    };
    let patches = 0;
    Object.assign(harness.ctx.config, {
      patchSecretRefs: vi.fn(async (input: { value: Record<string, unknown> | null }) => {
        patches += 1;
        if (patches === 2 && input.value === null) {
          await harness.ctx.state.set(markerScope, replacement);
        }
      }),
    });
    Object.assign(harness.ctx.secrets, { resolve: vi.fn(async () => "xoxb-test-secret-value") });
    vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/auth.test")) {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T0123ABCD",
          user_id: "U0123ABCD",
          bot_id: "B0123ABCD",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, bot: { app_id: "A0123ABCD" } }), { status: 200 });
    });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction(
      "discover-slack-install-metadata",
      { botTokenSecretId: FAKE_SECRET_ID },
      { companyId: COMPANY_A },
    );

    expect(harness.getState(markerScope)).toEqual(replacement);
  });

  it("retains the current discovery marker when binding cleanup fails", async () => {
    const harness = harnessWithSetup();
    const markerScope = {
      scopeKind: "company" as const,
      scopeId: COMPANY_A,
      namespace: "slack-setup-bindings",
      stateKey: `metadata:${FAKE_SECRET_ID}`,
    };
    let patches = 0;
    Object.assign(harness.ctx.config, {
      patchSecretRefs: vi.fn(async (input: { value: Record<string, unknown> | null }) => {
        patches += 1;
        if (patches === 2 && input.value === null) throw new Error("cleanup failed");
      }),
    });
    Object.assign(harness.ctx.secrets, { resolve: vi.fn(async () => "xoxb-test-secret-value") });
    vi.spyOn(harness.ctx.http, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/auth.test")) {
        return new Response(JSON.stringify({
          ok: true,
          team_id: "T0123ABCD",
          user_id: "U0123ABCD",
          bot_id: "B0123ABCD",
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, bot: { app_id: "A0123ABCD" } }), { status: 200 });
    });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction(
      "discover-slack-install-metadata",
      { botTokenSecretId: FAKE_SECRET_ID },
      { companyId: COMPANY_A },
    )).rejects.toThrow("cleanup failed");
    expect(harness.getState(markerScope)).toEqual({
      version: 1,
      owner: expect.stringMatching(/^[0-9a-f]{32}$/),
      path: ["setup", "slack", "metadata", expect.stringMatching(/^[0-9a-f]{32}$/)],
    });
  });

  it("rebinds the released v0.1.7/v0.1.8 sidecar refs without resolving secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slack-legacy-rebind-"));
    const previousPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    const sidecarPath = join(directory, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    try {
      await writeFile(sidecarPath, JSON.stringify({
        version: 1,
        identities: {
          "agent-slack-1:slack": {
            slackBotToken: { botTokenSecretId: FAKE_SECRET_ID },
          },
          "agent-slack-1:github": { secretId: FAKE_SECRET_ID_2 },
        },
      }));
      const harness = harnessWithSetup();
      const resolve = vi.fn();
      Object.assign(harness.ctx.secrets, { resolve });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(CONFIG_SCOPE, {
        version: 4,
        identities: {
          "agent-slack-1:slack": {
            provider: "slack",
            id: "agent-slack-1:slack",
            agentId: "agent-slack-1",
            label: "Released Slack Bot",
            slack: { teamId: "TOLD", appId: "AOLD", botUserId: "UOLD" },
          },
        },
      });

      const before = await harness.getData<BotIdentitySettingsData>("bot-identity-config", { companyId: COMPANY_A });
      expect(before.identities[0]?.credentialStatus).toBe("rebind-required");
      expect(before.identities[0]?.slackSetup?.legacyCredential).toEqual({
        status: "rebind-required",
        signingSecretRequired: true,
      });
      expect(before.identities[0]?.slackSetup?.botTokenSecretId).toBeUndefined();

      const result = await harness.performAction(
        "rebind-legacy-slack-credentials",
        { agentId: "agent-slack-1", signingSecretId: FAKE_SIGNING_SECRET_ID },
        { companyId: COMPANY_A },
      );

      expect(result).toEqual({ agentId: "agent-slack-1", provider: "slack", status: "rebound" });
      expect(resolve).not.toHaveBeenCalled();
      expect(harness.getCompanyConfig()).toMatchObject({
        identities: {
          "agent-slack-1": {
            githubUsername: "shared-agent[bot]",
            slack: {
              label: "Released Slack Bot",
              teamId: "TOLD",
              appId: "AOLD",
              botUserId: "UOLD",
              credentials: {
                botToken: { type: "secret_ref", secretId: FAKE_SECRET_ID, version: "latest" },
                signingSecret: { type: "secret_ref", secretId: FAKE_SIGNING_SECRET_ID, version: "latest" },
              },
            },
          },
        },
      });
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
      expect(sidecar.identities["agent-slack-1:slack"]).toBeUndefined();
      expect(sidecar.identities["agent-slack-1:github"]).toEqual({ secretId: FAKE_SECRET_ID_2 });
    } finally {
      if (previousPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
      else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains a working host binding and reports cleanup-pending when legacy sidecar cleanup fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slack-legacy-cleanup-"));
    const previousPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    const sidecarPath = join(directory, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    const releasedEntry = {
      version: 1,
      identities: {
        "agent-slack-1:slack": {
          slackBotToken: {
            botTokenSecretId: FAKE_SECRET_ID,
            signingSecretId: FAKE_SIGNING_SECRET_ID,
          },
        },
      },
    };
    try {
      await writeFile(sidecarPath, JSON.stringify(releasedEntry));
      const harness = harnessWithSetup();
      const originalPatch = harness.patchSecretRefs.getMockImplementation()!;
      harness.patchSecretRefs.mockImplementation(async (input) => {
        await originalPatch(input);
        if (input.path.join(".") === "identities.agent-slack-1.slack" && input.value) {
          await writeFile(sidecarPath, "not valid JSON");
        }
      });
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(CONFIG_SCOPE, {
        version: 4,
        identities: {
          "agent-slack-1:slack": {
            provider: "slack",
            id: "agent-slack-1:slack",
            agentId: "agent-slack-1",
            label: "Released Slack Bot",
            slack: { teamId: "TOLD", appId: "AOLD", botUserId: "UOLD" },
          },
        },
      });

      await expect(harness.performAction(
        "rebind-legacy-slack-credentials",
        { agentId: "agent-slack-1" },
        { companyId: COMPANY_A },
      )).resolves.toEqual({
        agentId: "agent-slack-1",
        provider: "slack",
        status: "cleanup-pending",
      });
      expect(harness.getCompanyConfig()).toHaveProperty(
        "identities.agent-slack-1.slack.credentials.botToken.secretId",
        FAKE_SECRET_ID,
      );
      const pending = await harness.getData<BotIdentitySettingsData>("bot-identity-config", { companyId: COMPANY_A });
      expect(pending.cleanupPending).toEqual([
        expect.objectContaining({
          agentId: "agent-slack-1",
          operation: "legacy-sidecar-delete",
          source: "legacy-rebind",
        }),
      ]);

      await writeFile(sidecarPath, JSON.stringify(releasedEntry));
      harness.patchSecretRefs.mockImplementation(originalPatch);
      await expect(harness.performAction(
        "rebind-legacy-slack-credentials",
        { agentId: "agent-slack-1" },
        { companyId: COMPANY_A },
      )).resolves.toEqual({
        agentId: "agent-slack-1",
        provider: "slack",
        status: "rebound",
      });
      expect(harness.patchSecretRefs).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(sidecarPath, "utf8")).identities).toEqual({});
    } finally {
      if (previousPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
      else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a conflicting existing Slack host binding without overwriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slack-legacy-conflict-"));
    const previousPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    const sidecarPath = join(directory, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    try {
      await writeFile(sidecarPath, JSON.stringify({
        version: 1,
        identities: {
          "agent-slack-1:slack": {
            slackBotToken: {
              botTokenSecretId: FAKE_SECRET_ID,
              signingSecretId: FAKE_SIGNING_SECRET_ID,
            },
          },
        },
      }));
      const harness = harnessWithSetup();
      const originalPatch = harness.patchSecretRefs.getMockImplementation()!;
      await originalPatch({
        companyId: COMPANY_A,
        path: ["identities", "agent-slack-1", "slack"],
        value: {
          label: "Different Slack Bot",
          teamId: "TDIFFERENT",
          appId: "ADIFFERENT",
          botUserId: "UDIFFERENT",
          credentials: {
            botToken: { type: "secret_ref", secretId: FAKE_SECRET_ID_2, version: "latest" },
            signingSecret: { type: "secret_ref", secretId: FAKE_SIGNING_SECRET_ID, version: "latest" },
          },
        },
      });
      harness.patchSecretRefs.mockClear();
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(CONFIG_SCOPE, {
        version: 4,
        identities: {
          "agent-slack-1:slack": {
            provider: "slack",
            id: "agent-slack-1:slack",
            agentId: "agent-slack-1",
            label: "Released Slack Bot",
            slack: { teamId: "TOLD", appId: "AOLD", botUserId: "UOLD" },
          },
        },
      });

      await expect(harness.performAction(
        "rebind-legacy-slack-credentials",
        { agentId: "agent-slack-1" },
        { companyId: COMPANY_A },
      )).rejects.toThrow(/conflicts/);
      expect(harness.patchSecretRefs).not.toHaveBeenCalled();
      expect(harness.getCompanyConfig()).toHaveProperty(
        "identities.agent-slack-1.slack.teamId",
        "TDIFFERENT",
      );
    } finally {
      if (previousPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
      else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the released signingSecretId when the sidecar already contains it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "slack-legacy-signing-"));
    const previousPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    const sidecarPath = join(directory, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    try {
      await writeFile(sidecarPath, JSON.stringify({
        version: 1,
        identities: {
          "agent-slack-1:slack": {
            slackBotToken: {
              botTokenSecretId: FAKE_SECRET_ID,
              signingSecretId: FAKE_SIGNING_SECRET_ID,
            },
          },
        },
      }));
      const harness = harnessWithSetup();
      await plugin.definition.setup(harness.ctx);
      await harness.ctx.state.set(CONFIG_SCOPE, {
        version: 4,
        identities: {
          "agent-slack-1:slack": {
            provider: "slack",
            id: "agent-slack-1:slack",
            agentId: "agent-slack-1",
            label: "Released Slack Bot",
            slack: { teamId: "TOLD", appId: "AOLD", botUserId: "UOLD" },
          },
        },
      });

      await expect(harness.performAction(
        "rebind-legacy-slack-credentials",
        { agentId: "agent-slack-1" },
        { companyId: COMPANY_A },
      )).resolves.toMatchObject({ status: "rebound" });
      expect(harness.getCompanyConfig()).toHaveProperty(
        "identities.agent-slack-1.slack.credentials.signingSecret.secretId",
        FAKE_SIGNING_SECRET_ID,
      );
    } finally {
      if (previousPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
      else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects released-sidecar rebind without host company authorization or agent membership", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction(
      "rebind-legacy-slack-credentials",
      { agentId: "agent-slack-1", signingSecretId: FAKE_SIGNING_SECRET_ID },
    )).rejects.toThrow(/host-authorized companyId/);
    await expect(harness.performAction(
      "rebind-legacy-slack-credentials",
      { agentId: "agent-in-other-company", signingSecretId: FAKE_SIGNING_SECRET_ID },
      { companyId: COMPANY_A },
    )).rejects.toThrow(/does not belong/);
  });

  it("holds the shared mutation queue through delete rollback before a concurrent save commits B", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);
    const flowA = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Slack A", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );
    await harness.performAction(
      "save-slack-install-metadata",
      {
        state: flowA.state,
        agentId: "agent-slack-1",
        teamId: "TA",
        appId: "AA",
        botUserId: "UA",
        botTokenSecretId: FAKE_SECRET_ID,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );
    const flowB = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Slack B", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    const deleteStateReached = deferred();
    const releaseDeleteFailure = deferred();
    const originalSet = harness.ctx.state.set.bind(harness.ctx.state);
    let failedDeleteStateWrite = false;
    vi.spyOn(harness.ctx.state, "set").mockImplementation(async (scope, value) => {
      if (
        !failedDeleteStateWrite
        && scope.scopeKind === "instance"
        && scope.stateKey === CONFIG_SCOPE.stateKey
        && !(value as { identities?: Record<string, unknown> }).identities?.["agent-slack-1:slack"]
      ) {
        failedDeleteStateWrite = true;
        deleteStateReached.resolve();
        await releaseDeleteFailure.promise;
        throw new Error("state write failed");
      }
      await originalSet(scope, value);
    });
    harness.patchSecretRefs.mockClear();

    const deleting = harness.performAction(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-slack-1" },
      { companyId: COMPANY_A },
    );
    await deleteStateReached.promise;
    expect(harness.getCompanyConfig()).not.toHaveProperty("identities.agent-slack-1.slack");

    const saving = harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: flowB.state,
        agentId: "agent-slack-1",
        teamId: "TB",
        appId: "AB",
        botUserId: "UB",
        botTokenSecretId: FAKE_SECRET_ID_2,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );
    await Promise.resolve();
    expect(harness.patchSecretRefs).toHaveBeenCalledTimes(1);

    releaseDeleteFailure.resolve();
    await expect(deleting).rejects.toThrow("state write failed");
    await expect(saving).resolves.toMatchObject({ status: "saved", teamId: "TB" });

    expect(harness.patchSecretRefs.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ path: ["identities", "agent-slack-1", "slack"], value: null }),
      expect.objectContaining({ path: ["identities", "agent-slack-1", "slack"], value: expect.objectContaining({ teamId: "TA" }) }),
      expect.objectContaining({ path: ["identities", "agent-slack-1", "slack"], value: expect.objectContaining({ teamId: "TB" }) }),
    ]);
    expect(harness.getCompanyConfig()).toHaveProperty("identities.agent-slack-1.slack.teamId", "TB");
    expect(harness.getState(CONFIG_SCOPE)).toHaveProperty(
      "identities.agent-slack-1:slack.slack.teamId",
      "TB",
    );
  });

  it("migrates the flat Slack company config written by earlier builds of this PR", async () => {
    const harness = harnessWithSetup();
    const legacySlackConfig = {
      label: "Legacy Slack Bot",
      teamId: "TOLD",
      appId: "AOLD",
      botUserId: "UOLD",
      credentials: {
        botToken: { type: "secret_ref", secretId: FAKE_SECRET_ID, version: "latest" },
        signingSecret: { type: "secret_ref", secretId: FAKE_SIGNING_SECRET_ID, version: "latest" },
      },
    };
    const getConfig = vi.fn(async (companyId?: string) => companyId === COMPANY_A
      ? { identities: { "agent-slack-1": legacySlackConfig } }
      : { identities: {} });
    Object.assign(harness.ctx.config, { get: getConfig });
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Migrated Slack Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );
    await harness.performAction<SaveSlackInstallMetadataResult>(
      "save-slack-install-metadata",
      {
        state: created.state,
        agentId: "agent-slack-1",
        teamId: "TNEW",
        appId: "ANEW",
        botUserId: "UNEW",
        botTokenSecretId: FAKE_SECRET_ID_2,
        signingSecretId: FAKE_SIGNING_SECRET_ID,
      },
      { companyId: COMPANY_A },
    );

    expect(harness.patchSecretRefs).toHaveBeenCalledWith({
      companyId: COMPANY_A,
      path: ["identities", "agent-slack-1"],
      value: {
        slack: expect.objectContaining({
          label: "Migrated Slack Bot",
          teamId: "TNEW",
          appId: "ANEW",
          botUserId: "UNEW",
        }),
      },
    });
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
      cleanupTombstones: {},
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
      cleanupTombstones: {},
      identities: {
        [previousSelectedIdentity.id]: previousSelectedIdentity,
        [unrelatedIdentity.id]: unrelatedIdentity,
      },
    });
    expect(harness.getCompanyConfig()).toEqual({
      identities: {
        "agent-preserved": PRESERVED_COMPANY_IDENTITY,
        "agent-slack-1": {
          label: "Preserved GitHub identity for shared agent",
          githubUsername: "shared-agent[bot]",
        },
      },
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

  it("surfaces every state rollback failure after an atomic config patch fails", async () => {
    const harness = harnessWithSetup();
    await plugin.definition.setup(harness.ctx);

    const created = await harness.performAction<CreateSlackAppManifestResult>(
      "create-slack-app-manifest",
      { agentId: "agent-slack-1", label: "Rollback Failure Bot", eventsRequestUrl: EVENTS_REQUEST_URL },
      { companyId: COMPANY_A },
    );

    harness.patchSecretRefs.mockRejectedValueOnce(new Error("atomic config patch failed"));
    const originalStateSet = harness.ctx.state.set.bind(harness.ctx.state);
    let settingsWrites = 0;
    vi.spyOn(harness.ctx.state, "set").mockImplementation(async (scope, value) => {
      if (scope.scopeKind === "instance" && scope.stateKey === CONFIG_SCOPE.stateKey) {
        settingsWrites += 1;
        if (settingsWrites === 2) throw new Error("settings rollback failed");
      }
      if (
        scope.scopeKind === "company"
        && scope.stateKey.startsWith("slack-app-manifest-flow:")
        && typeof value === "object"
        && value !== null
        && !("consumed" in value)
      ) {
        throw new Error("flow rollback failed");
      }
      await originalStateSet(scope, value);
    });

    let failure: unknown;
    try {
      await harness.performAction<SaveSlackInstallMetadataResult>(
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
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toMatch(/could not be fully restored/);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "atomic config patch failed",
      "settings rollback failed",
      "flow rollback failed",
    ]);
  });
});
