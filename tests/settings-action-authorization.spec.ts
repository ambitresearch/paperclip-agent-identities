import { describe, expect, it, vi } from "vitest";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { requireHumanSettingsActor } from "../src/core/settings-action-authorization.js";

const COMPANY_ID = "00000000-0000-4000-8000-0000000000a1";
const SECRET_ID = "00000000-0000-4000-8000-000000000010";
const SIGNING_SECRET_ID = "00000000-0000-4000-8000-000000000011";

const protectedActions = [
  {
    key: "save-bot-identity-config",
    params: { provider: "github", agentId: "agent-1", label: "Agent One", github: { username: "agent-one[bot]" } },
  },
  {
    key: "delete-bot-identity-config",
    params: { provider: "github", agentId: "agent-1" },
  },
  {
    key: "create-github-app-manifest",
    params: { provider: "github", agentId: "agent-1", label: "Agent One" },
  },
  {
    key: "get-github-app-manifest-flow",
    params: { state: "pc_blocked" },
  },
  {
    key: "convert-github-app-manifest",
    params: { state: "pc_blocked", code: "one-time-code" },
  },
  {
    key: "create-slack-app-manifest",
    params: { agentId: "agent-1", label: "Agent One", eventsRequestUrl: "https://example.com/events" },
  },
  {
    key: "get-slack-app-manifest-flow",
    params: { state: "pc_blocked" },
  },
  {
    key: "discover-slack-install-metadata",
    params: { botTokenSecretId: SECRET_ID },
  },
  {
    key: "save-slack-install-metadata",
    params: {
      state: "pc_blocked",
      agentId: "agent-1",
      teamId: "T0123ABCD",
      appId: "A0123ABCD",
      botUserId: "U0123ABCD",
      botTokenSecretId: SECRET_ID,
      signingSecretId: SIGNING_SECRET_ID,
    },
  },
  {
    key: "rebind-legacy-slack-credentials",
    params: { agentId: "agent-1", signingSecretId: SIGNING_SECRET_ID },
  },
] as const;

describe("human settings action authorization", () => {
  it.each([
    { name: "local implicit user", context: { actor: { type: "user", userId: null } }, allowed: true },
    { name: "authenticated user", context: { actor: { type: "user", userId: "user-1" } }, allowed: true },
    { name: "agent", context: { actor: { type: "agent", agentId: "agent-1" } }, allowed: false },
    { name: "system", context: { actor: { type: "system" } }, allowed: false },
    { name: "missing context", context: undefined, allowed: false },
    { name: "missing actor", context: {}, allowed: false },
    { name: "null actor", context: { actor: null }, allowed: false },
    { name: "malformed actor", context: { actor: {} }, allowed: false },
  ])("handles $name", ({ context, allowed }) => {
    const invoke = () => requireHumanSettingsActor(context);
    if (allowed) expect(invoke).not.toThrow();
    else expect(invoke).toThrow("This settings action requires a human user actor.");
  });

  describe.each(["agent", "system"] as const)("%s actor", (actorType) => {
    it.each(protectedActions)("denies $key before state, config, secret, or HTTP access", async ({ key, params }) => {
      const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
      await plugin.definition.setup(harness.ctx);

      const stateGet = vi.spyOn(harness.ctx.state, "get");
      const stateSet = vi.spyOn(harness.ctx.state, "set");
      const stateDelete = vi.spyOn(harness.ctx.state, "delete");
      const configGet = vi.spyOn(harness.ctx.config, "get");
      const configPatch = vi.fn();
      Object.assign(harness.ctx.config, { patchSecretRefs: configPatch });
      const secretResolve = vi.spyOn(harness.ctx.secrets, "resolve");
      const httpFetch = vi.spyOn(harness.ctx.http, "fetch");
      const agentsList = vi.spyOn(harness.ctx.agents, "list");

      await expect(harness.performAction(
        key,
        params,
        {
          companyId: COMPANY_ID,
          actor: {
            type: actorType,
            agentId: actorType === "agent" ? "calling-agent" : null,
            companyId: COMPANY_ID,
          },
        },
      )).rejects.toThrow("This settings action requires a human user actor.");

      for (const dependency of [
        stateGet,
        stateSet,
        stateDelete,
        configGet,
        configPatch,
        secretResolve,
        httpFetch,
        agentsList,
      ]) {
        expect(dependency).not.toHaveBeenCalled();
      }
    });
  });

  it.each(protectedActions)("allows a user actor to reach $key's downstream work", async ({ key, params }) => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.seed({ agents: [{ id: "agent-1", companyId: COMPANY_ID, name: "Agent One" } as never] });
    await plugin.definition.setup(harness.ctx);

    const downstreamError = new Error("authorized action reached downstream work");
    const stateGet = vi.spyOn(harness.ctx.state, "get");
    const stateSet = vi.spyOn(harness.ctx.state, "set");
    const agentsList = vi.spyOn(harness.ctx.agents, "list");

    if (key === "create-github-app-manifest") stateSet.mockRejectedValue(downstreamError);
    else if (key === "rebind-legacy-slack-credentials") stateGet.mockRejectedValue(downstreamError);
    else if (key.startsWith("save-bot-") || key.startsWith("delete-bot-") || key.startsWith("create-slack-")) {
      agentsList.mockRejectedValue(downstreamError);
    } else stateGet.mockRejectedValue(downstreamError);

    await expect(harness.performAction(
      key,
      params,
      { companyId: COMPANY_ID, actor: { type: "user", userId: null, companyId: COMPANY_ID } },
    )).rejects.toThrow("authorized action reached downstream work");
  });

  it("allows a local implicit user to run an unscoped protected action", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction(
      "save-bot-identity-config",
      {
        provider: "github",
        agentId: "local-agent",
        label: "Local Agent",
        github: { username: "local-agent[bot]" },
      },
      { actor: { type: "user", userId: null } },
    )).resolves.toMatchObject({ agentId: "local-agent", provider: "github" });
  });

  it("rejects scoped GitHub save/delete for another company's agent before state access", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.seed({
      agents: [
        { id: "agent-1", companyId: COMPANY_ID, name: "Agent One" } as never,
        { id: "agent-2", companyId: "00000000-0000-4000-8000-0000000000b1", name: "Agent Two" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);
    const stateGet = vi.spyOn(harness.ctx.state, "get");
    const userActor = { type: "user" as const, userId: null, companyId: COMPANY_ID };

    await expect(harness.performAction(
      "save-bot-identity-config",
      { provider: "github", agentId: "agent-2", label: "Wrong Company", github: { username: "wrong[bot]" } },
      { companyId: COMPANY_ID, actor: userActor },
    )).rejects.toThrow("agentId does not belong to the host-authorized company.");
    await expect(harness.performAction(
      "delete-bot-identity-config",
      { provider: "github", agentId: "agent-2" },
      { companyId: COMPANY_ID, actor: userActor },
    )).rejects.toThrow("agentId does not belong to the host-authorized company.");

    expect(stateGet).not.toHaveBeenCalled();
  });

  it("validates both agents when moving a company-scoped GitHub identity", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.seed({
      agents: [
        { id: "agent-1", companyId: COMPANY_ID, name: "Agent One" } as never,
        { id: "agent-2", companyId: "00000000-0000-4000-8000-0000000000b1", name: "Agent Two" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);
    const stateGet = vi.spyOn(harness.ctx.state, "get");

    await expect(harness.performAction(
      "save-bot-identity-config",
      {
        provider: "github",
        previousAgentId: "agent-2",
        agentId: "agent-1",
        label: "Moved Agent",
        github: { username: "moved-agent[bot]" },
      },
      { companyId: COMPANY_ID, actor: { type: "user", userId: null, companyId: COMPANY_ID } },
    )).rejects.toThrow("agentId does not belong to the host-authorized company.");

    expect(stateGet).not.toHaveBeenCalled();
  });

  it("rejects malformed action context at the registered handler boundary", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    let saveHandler: ((params: Record<string, unknown>, context: PluginPerformActionContext) => Promise<unknown>) | undefined;
    const register = harness.ctx.actions.register.bind(harness.ctx.actions);
    vi.spyOn(harness.ctx.actions, "register").mockImplementation((key, handler) => {
      if (key === "save-bot-identity-config") saveHandler = handler;
      register(key, handler);
    });
    await plugin.definition.setup(harness.ctx);

    const stateGet = vi.spyOn(harness.ctx.state, "get");
    expect(saveHandler).toBeDefined();
    await expect(saveHandler!({ provider: "github" }, undefined as unknown as PluginPerformActionContext)).rejects.toThrow(
      "This settings action requires a human user actor.",
    );
    expect(stateGet).not.toHaveBeenCalled();
  });
});
