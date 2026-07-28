import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { CONFIG_SCOPE } from "../src/config-source.js";

const SLACK_CREDENTIALS = {
  botToken: {
    type: "secret_ref" as const,
    secretId: "00000000-0000-4000-8000-000000000001",
    version: "latest" as const,
  },
  signingSecret: {
    type: "secret_ref" as const,
    secretId: "00000000-0000-4000-8000-000000000002",
    version: "latest" as const,
  },
};

describe("worker provider registration", () => {
  it("registers every enabled-provider tool plus opted-in live tools from coming-soon providers, and nothing else", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    const register = vi.spyOn(harness.ctx.tools, "register");
    await plugin.definition.setup(harness.ctx);

    // github (enabled) contributes all of its tools. slack is now also
    // "enabled" as a provider (slack_bot_lookup_channel, DRO-975/DRO-1160,
    // was the last backlog item), so its full tool surface registers too --
    // through the generic registration seam, not a provider-id branch.
    // example is coming-soon with no `live` tools, so it stays fully dormant.
    const registeredNames = register.mock.calls.map(([name]) => name);
    const slackNames = [
      "slack_bot_whoami",
      "slack_bot_post_message",
      "slack_bot_add_reaction",
      "slack_bot_remove_reaction",
      "slack_bot_lookup_channel",
    ];
    expect(registeredNames[0]).toBe("github_bot_whoami");
    expect(registeredNames.slice(-slackNames.length)).toEqual(slackNames);
    expect(new Set(registeredNames).size).toBe(registeredNames.length);
    expect(registeredNames).toEqual(
      expect.arrayContaining([
        "github_bot_create_pull_request",
        "github_bot_push_branch",
        "github_bot_submit_pull_request_review",
        "github_bot_add_issue_comment",
        "github_bot_list_issue_comments",
        "github_bot_get_issue",
        "github_bot_update_issue",
        "github_bot_get_pull_request",
        "github_bot_list_pull_request_files",
        "github_bot_list_organization_projects",
        "github_bot_add_pull_request_to_project",
        "github_bot_assign_to_current_user",
        "github_bot_update_pull_request",
        "github_bot_get_pull_request_checks",
        "github_bot_request_pull_request_reviewers",
        ...slackNames,
      ])
    );
    // `example` is coming-soon (`toolsStatus` falls back to `status`) and
    // none of its tool specs set `live: true`, so its tool stays out of the
    // live registration loop even though its `tools` array is non-empty —
    // the same invariant `.enabled()` used to guarantee for every
    // coming-soon provider, now scoped by `toolsEnabled()`/`liveTools()`
    // (provider-contract.ts's `toolsStatus` + per-tool `live`) instead.
    expect(register.mock.calls.map(([name]) => name)).not.toContain("example_whoami");
  });

  it("makes slack_bot_post_message reachable in BOTH runtime registration and the composed manifest, even though the Slack settings UI is still coming-soon", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    const register = vi.spyOn(harness.ctx.tools, "register");
    await plugin.definition.setup(harness.ctx);

    expect(register.mock.calls.map(([name]) => name)).toContain("slack_bot_post_message");
    expect((manifest.tools ?? []).map((tool) => (tool as { name: string }).name)).toContain(
      "slack_bot_post_message",
    );
  });

  it("resolves GitHub from instance config and Slack from authoritative state for the same agent", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          "agent-1": {
            label: "GitHub Bot",
            githubUsername: "github-bot[bot]",
            slack: {
              label: "Slack Bot",
              teamId: "T1",
              appId: "A1",
              botUserId: "U1",
              credentials: SLACK_CREDENTIALS,
            },
          },
        },
      },
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Slack Bot",
          slack: { teamId: "T1", appId: "A1", botUserId: "U1" },
        },
      },
    });

    const github = await harness.executeTool<{ data?: { githubUsername: string } }>(
      "github_bot_whoami",
      {},
      { companyId: "company-1", agentId: "agent-1" },
    );
    const slack = await harness.executeTool<{ data?: { teamId: string } }>(
      "slack_bot_whoami",
      {},
      { companyId: "company-1", agentId: "agent-1" },
    );

    expect(github.data?.githubUsername).toBe("github-bot[bot]");
    expect(slack.data?.teamId).toBe("T1");
  });

  it("fails closed through the generic pipeline when no identity is configured", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: { identities: {} },
    });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<{ error?: string }>(
      "github_bot_whoami", {}, { companyId: "company-1", agentId: "agent-missing" },
    );
    expect(result.error).toContain("github_bot_whoami failed closed for agent 'agent-missing'");
  });

  it("does not read settings state when an instance-first provider has valid static config", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          "agent-1": { label: "GitHub Bot", githubUsername: "github-bot[bot]" },
        },
      },
    });
    const getState = vi.spyOn(harness.ctx.state, "get");
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool<{ data?: { githubUsername: string } }>(
      "github_bot_whoami",
      {},
      { companyId: "company-1", agentId: "agent-1" },
    );

    expect(result.data?.githubUsername).toBe("github-bot[bot]");
    expect(getState).not.toHaveBeenCalled();
  });

  it("does not read instance config when a state-first provider has valid settings state", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {},
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Slack Bot",
          slack: { teamId: "T1", appId: "A1", botUserId: "U1" },
        },
      },
    });
    const getConfig = vi.spyOn(harness.ctx.config, "get").mockRejectedValue(new Error("config unavailable"));

    const result = await harness.executeTool<{ data?: { teamId: string } }>(
      "slack_bot_whoami",
      {},
      { companyId: "company-1", agentId: "agent-1" },
    );

    expect(result.data?.teamId).toBe("T1");
    expect(getConfig).not.toHaveBeenCalled();
  });

  it("does not fall back to legacy instance metadata for an authoritative provider", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          "agent-1": {
            slack: {
              label: "Stale Slack Bot",
              teamId: "TOLD",
              appId: "AOLD",
              botUserId: "UOLD",
            },
          },
        },
      },
    });
    await plugin.definition.setup(harness.ctx);
    const getConfig = vi.spyOn(harness.ctx.config, "get");

    const result = await harness.executeTool<{ error?: string }>(
      "slack_bot_whoami",
      {},
      { companyId: "company-1", agentId: "agent-1" },
    );

    expect(result.error).toContain("No settings-page state is configured");
    expect(getConfig).not.toHaveBeenCalled();
  });

  // Regression test for the changes-requested review on DRO-976: the
  // Settings UI's "check Slack status" readout calls `slack_bot_whoami` via
  // `usePluginAction`, which reaches the worker through `performAction` --
  // NOT `executeTool`. A tool registered only via `ctx.tools.register` is
  // unreachable from `usePluginAction` (see PLUGIN_SPEC.md §13.9 vs §13.10),
  // so `slack_bot_whoami` must ALSO be registered as an action (via
  // `uiActionInvocable: true` and `registry.uiInvocableLiveTools()`) for the
  // Settings UI bridge to work at all.
  it("also registers uiActionInvocable live tools (e.g. slack_bot_whoami) as plugin actions reachable via performAction", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          "agent-1": { slack: { credentials: SLACK_CREDENTIALS } },
        },
      },
    });
    harness.seed({
      agents: [
        { id: "agent-1", companyId: "company-1", name: "Bot", role: "engineer", title: null, status: "idle" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Bot",
          slack: { teamId: "T1", appId: "A1", botUserId: "U1" },
        },
      },
    });

    const result = await harness.performAction<{ data?: { teamId: string } }>(
      "slack_bot_whoami",
      { agentId: "agent-1" },
      { companyId: "company-1" },
    );
    expect(result.data?.teamId).toBe("T1");
  });

  // Regression test for the Copilot finding on PR #84 (fa1d97b): a
  // uiActionInvocable action only had params.agentId as caller input, with
  // no check that it belongs to the host-authorized company from
  // actionContext -- so a caller scoped to one company could read another
  // company's agent's provider status/identity metadata. Verify a
  // cross-company agentId is now rejected rather than resolved.
  it("rejects a UI-invocable tool request for an agent outside the host-authorized company", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          "agent-other": { slack: { label: "Other", teamId: "T2", appId: "A2", botUserId: "U2" } },
        },
      },
    });
    harness.seed({
      agents: [
        { id: "agent-1", companyId: "company-1", name: "Allowed" } as never,
        { id: "agent-other", companyId: "company-2", name: "Other" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction(
        "slack_bot_whoami",
        { agentId: "agent-other", companyId: "company-2" },
        { companyId: "company-1" },
      ),
    ).rejects.toThrow("agentId does not belong to the host-authorized company");
  });

  it("rejects a UI-invocable tool request with no host company scope before listing agents", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          "agent-1": { slack: { label: "Bot", teamId: "T1", appId: "A1", botUserId: "U1" } },
        },
      },
    });
    const listAgents = vi.spyOn(harness.ctx.agents, "list");
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction(
        "slack_bot_whoami",
        { agentId: "agent-1" },
        { companyId: "" },
      ),
    ).rejects.toThrow("requires a host-authorized companyId");
    expect(listAgents).not.toHaveBeenCalled();
  });

  it("does not register credentialed tools (e.g. github_bot_create_pull_request) as plugin actions", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    const register = vi.spyOn(harness.ctx.actions, "register");
    await plugin.definition.setup(harness.ctx);

    expect(register.mock.calls.map(([name]) => name)).not.toContain("github_bot_create_pull_request");
    expect(register.mock.calls.map(([name]) => name)).not.toContain("github_bot_push_branch");
    expect(register.mock.calls.map(([name]) => name)).toContain("slack_bot_whoami");
  });
});
