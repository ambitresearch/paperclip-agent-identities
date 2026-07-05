import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin scaffold", () => {
  it("declares capabilities for its manifest features", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
    expect(manifest.capabilities).toContain("agent.tools.register");
  });

  it("registers data + actions and handles events", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
    expect(harness.getState({ scopeKind: "issue", scopeId: "iss_1", stateKey: "seen" })).toBe(true);

    const data = await harness.getData<{ status: string }>("health");
    expect(data.status).toBe("ok");

    const action = await harness.performAction<{ pong: boolean }>("ping");
    expect(action.pong).toBe(true);
  });

  it("returns a safe identity summary for configured agents", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        agentIdentities: [
          {
            companyId: "company_1",
            agentId: "agent_1",
            label: "Droidshop CTO",
            githubUsername: "paperclip-kiln-lathe",
            allowedOwners: ["roshangautam"],
            allowedRepos: ["paperclip-github-bot-identity-plugin"],
            commitName: "Kiln Lathe",
            commitEmail: "kiln@example.com",
            tokenSecretRef: "secret://github/bot/token"
          }
        ]
      }
    });
    await plugin.definition.setup(harness.ctx);

    const whoami = await harness.executeTool<{
      content?: string;
      error?: string;
      data?: Record<string, unknown>;
    }>("github_bot_whoami", {}, { companyId: "company_1", agentId: "agent_1" });

    expect(whoami.error).toBeUndefined();
    expect(whoami.data).toEqual({
      label: "Droidshop CTO",
      githubUsername: "paperclip-kiln-lathe",
      allowedOwners: ["roshangautam"],
      allowedRepos: ["paperclip-github-bot-identity-plugin"],
      hasCommitName: true,
      hasCommitEmail: true
    });
    expect(whoami.content).toContain("Droidshop CTO");
    expect(whoami.content).toContain("@paperclip-kiln-lathe");
    expect(whoami.data?.tokenSecretRef).toBeUndefined();
    expect(whoami.data?.token).toBeUndefined();
  });

  it("fails closed for unconfigured agents", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        agentIdentities: [
          {
            companyId: "company_1",
            agentId: "agent_1",
            label: "Droidshop CTO",
            githubUsername: "paperclip-kiln-lathe",
            allowedOwners: ["roshangautam"],
            allowedRepos: ["paperclip-github-bot-identity-plugin"]
          }
        ]
      }
    });
    await plugin.definition.setup(harness.ctx);

    const whoami = await harness.executeTool<{ content?: string; error?: string; data?: unknown }>(
      "github_bot_whoami",
      {},
      { companyId: "company_1", agentId: "agent_missing" }
    );

    expect(whoami.error).toContain("not configured");
    expect(whoami.data).toBeUndefined();
    expect(whoami.content).toBeUndefined();
  });
});
