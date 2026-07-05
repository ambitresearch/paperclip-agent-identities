import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("plugin scaffold", () => {
  it("declares capabilities for its manifest features", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
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
});

describe("bot identity settings", () => {
  it("declares settingsPage UI slot", () => {
    const settingsSlot = manifest.ui?.slots?.find(s => s.id === "bot-identity-settings");
    expect(settingsSlot).toBeDefined();
    expect(settingsSlot!.type).toBe("settingsPage");
    expect(settingsSlot!.exportName).toBe("SettingsPage");
  });

  it("returns null config when nothing is saved", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const config = await harness.getData("bot-identity-config");
    expect(config).toBeNull();
  });

  it("saves and retrieves bot identity config", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<{
      agentId: string;
      label: string;
      githubUsername: string;
      tokenSecretRef: string;
      allowedOwnerPattern: string;
    }>("save-bot-identity-config", {
      agentId: "agent-uuid-123",
      label: "QA Bot",
      githubUsername: "paperclip-qa-bot",
      tokenSecretRef: "GITHUB_QA_BOT_TOKEN",
      allowedOwnerPattern: "^roshangautam$",
    });

    expect(saved.agentId).toBe("agent-uuid-123");
    expect(saved.label).toBe("QA Bot");
    expect(saved.githubUsername).toBe("paperclip-qa-bot");
    expect(saved.tokenSecretRef).toBe("GITHUB_QA_BOT_TOKEN");
    expect(saved.allowedOwnerPattern).toBe("^roshangautam$");

    const config = await harness.getData<{
      agentId: string;
      label: string;
      githubUsername: string;
      tokenSecretRef: string;
      allowedOwnerPattern: string;
    }>("bot-identity-config");
    expect(config.agentId).toBe("agent-uuid-123");
    expect(config.githubUsername).toBe("paperclip-qa-bot");
  });

  it("rejects save when required fields are missing", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction("save-bot-identity-config", {
        agentId: "",
        label: "Test",
        githubUsername: "bot",
        tokenSecretRef: "TOKEN",
      })
    ).rejects.toThrow("Required fields");
  });

  it("defaults allowedOwnerPattern when empty", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<{ allowedOwnerPattern: string }>(
      "save-bot-identity-config",
      {
        agentId: "agent-1",
        label: "Test",
        githubUsername: "bot",
        tokenSecretRef: "TOKEN",
        allowedOwnerPattern: "",
      }
    );

    expect(saved.allowedOwnerPattern).toBe("^roshangautam$");
  });

  it("stores optional commit identity fields", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<{
      commitName?: string;
      commitEmail?: string;
    }>("save-bot-identity-config", {
      agentId: "agent-1",
      label: "Deploy Bot",
      githubUsername: "paperclip-deploy",
      tokenSecretRef: "DEPLOY_TOKEN",
      allowedOwnerPattern: "^roshangautam$",
      commitName: "Paperclip Deploy",
      commitEmail: "deploy@paperclip.ai",
    });

    expect(saved.commitName).toBe("Paperclip Deploy");
    expect(saved.commitEmail).toBe("deploy@paperclip.ai");
  });
});
