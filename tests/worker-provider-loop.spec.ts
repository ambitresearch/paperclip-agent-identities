import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("worker provider registration", () => {
  it("registers every enabled-provider tool plus opted-in live tools from coming-soon providers, and nothing else", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    const register = vi.spyOn(harness.ctx.tools, "register");
    await plugin.definition.setup(harness.ctx);

    // github (enabled) contributes all four of its tools. slack is still
    // "coming-soon" as a PROVIDER, but its whoami tool spec sets `live: true`
    // (DRO-972), so it registers too -- through the generic `liveTools()`
    // seam, not a provider-id branch. example is coming-soon with no `live`
    // tools, so it stays fully dormant.
    expect(register.mock.calls.map(([name]) => name)).toEqual([
      "github_bot_whoami",
      "github_bot_create_pull_request",
      "github_bot_push_branch",
      "github_bot_submit_pull_request_review",
      "slack_bot_whoami",
      "slack_bot_post_message",
      "slack_bot_add_reaction",
      "slack_bot_remove_reaction",
    ]);
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
          "agent-1": { label: "Bot", teamId: "T1", appId: "A1", botUserId: "U1" },
        },
      },
    });
    harness.seed({
      agents: [
        { id: "agent-1", companyId: "company-1", name: "Bot", role: "engineer", title: null, status: "idle" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);

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
          "agent-other": { label: "Other", teamId: "T2", appId: "A2", botUserId: "U2" },
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

  it("does not register credentialed tools (e.g. github_bot_create_pull_request) as plugin actions", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    const register = vi.spyOn(harness.ctx.actions, "register");
    await plugin.definition.setup(harness.ctx);

    expect(register.mock.calls.map(([name]) => name)).not.toContain("github_bot_create_pull_request");
    expect(register.mock.calls.map(([name]) => name)).not.toContain("github_bot_push_branch");
    expect(register.mock.calls.map(([name]) => name)).toContain("slack_bot_whoami");
  });
});
