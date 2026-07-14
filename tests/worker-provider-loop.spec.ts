import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("worker provider registration", () => {
  it("registers every enabled-provider tool plus opted-in live tools from coming-soon providers, and nothing else", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    const register = vi.spyOn(harness.ctx.tools, "register");
    await plugin.definition.setup(harness.ctx);

    // github (enabled) contributes all three of its tools. slack is still
    // "coming-soon" as a PROVIDER, but its whoami tool spec sets `live: true`
    // (DRO-972), so it registers too -- through the generic `liveTools()`
    // seam, not a provider-id branch. example is coming-soon with no `live`
    // tools, so it stays fully dormant.
    expect(register.mock.calls.map(([name]) => name)).toEqual([
      "github_bot_whoami",
      "github_bot_create_pull_request",
      "github_bot_push_branch",
      "slack_bot_whoami",
      "slack_bot_post_message",
      "slack_bot_add_reaction",
      "slack_bot_remove_reaction",
    ]);
    // `example` is coming-soon and does NOT set `toolsLive`, so its tool
    // stays out of the live registration loop even though its `tools` array
    // is non-empty — the same invariant `.enabled()` used to guarantee for
    // every coming-soon provider, now scoped by `toolsLive` instead.
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
});
