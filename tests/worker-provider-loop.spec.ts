import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("worker provider registration", () => {
  it("registers every enabled-provider tool and no coming-soon provider tool", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    const register = vi.spyOn(harness.ctx.tools, "register");
    await plugin.definition.setup(harness.ctx);

    expect(register.mock.calls.map(([name]) => name)).toEqual([
      "github_bot_whoami",
      "github_bot_create_pull_request",
      "github_bot_push_branch",
    ]);
    expect(register.mock.calls.map(([name]) => name)).not.toContain("example_whoami");
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
