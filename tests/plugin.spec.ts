import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { DEFAULT_ALLOWED_OWNER_PATTERN } from "../src/worker.js";
import type { BotIdentityConfig } from "../src/worker.js";
import { __resetGitCommandRunnerForTests, __setGitCommandRunnerForTests } from "../src/github-bot-push-branch.js";

afterEach(() => {
  __resetGitCommandRunnerForTests();
});

const TOOL_AGENT_ID = "agent-test";

function pushToolConfig(tokenSecretRef: string) {
  return {
    identities: {
      [TOOL_AGENT_ID]: {
        label: "Push Bot",
        githubUsername: "roshan-bot",
        tokenSecretRef
      }
    }
  };
}

function seedPrimaryWorkspace(harness: ReturnType<typeof createTestHarness>, repoUrl: string): void {
  harness.seed({
    projects: [{ id: "project-test", companyId: "company-test" } as never],
    projectWorkspaces: [
      {
        id: "ws-1",
        projectId: "project-test",
        name: "primary",
        path: "/tmp/workspace",
        repoUrl,
        repoRef: "main",
        defaultRef: "main",
        isPrimary: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  });
}

describe("plugin scaffold", () => {
  it("declares capabilities for its manifest features", () => {
    expect(manifest.capabilities).toContain("events.subscribe");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
    expect(manifest.capabilities).toContain("agent.tools.register");
    expect(manifest.capabilities).toContain("instance.settings.register");
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
        identities: {
          agent_1: {
            label: "Droidshop CTO",
            githubUsername: "paperclip-kiln-lathe",
            tokenSecretRef: "secret://github/bot/token",
            allowedOwnerPatterns: ["^roshangautam$"],
            allowedRepos: ["roshangautam/paperclip-github-bot-identity-plugin"],
            commitName: "Kiln Lathe",
            commitEmail: "kiln@example.com"
          }
        }
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
      allowedOwners: ["^roshangautam$"],
      allowedRepos: ["roshangautam/paperclip-github-bot-identity-plugin"],
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
        identities: {
          agent_1: {
            label: "Droidshop CTO",
            githubUsername: "paperclip-kiln-lathe",
            tokenSecretRef: "secret://github/bot/token",
            allowedOwnerPatterns: ["^roshangautam$"],
            allowedRepos: ["roshangautam/paperclip-github-bot-identity-plugin"]
          }
        }
      }
    });
    await plugin.definition.setup(harness.ctx);

    const whoami = await harness.executeTool<{ content?: string; error?: string; data?: unknown }>(
      "github_bot_whoami",
      {},
      { companyId: "company_1", agentId: "agent_missing" }
    );

    expect(whoami.error).toContain("failed closed");
    expect(whoami.error).toContain("Missing GitHub bot identity config");
    expect(whoami.data).toBeUndefined();
    expect(whoami.content).toBeUndefined();
  });

  it("allows mediated push for roshangautam repository", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    __setGitCommandRunnerForTests(async ({ args, env }) => {
      commands.push({ args, env });
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "git@github.com:roshangautam/paperclip-github-bot-identity-plugin.git\n",
          stderr: ""
        };
      }
      if (args[0] === "-c" && args[2] === "push") {
        return {
          exitCode: 0,
          stdout: "pushed\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");

    const result = await harness.executeTool(
      "github_bot_push_branch",
      {
        branch: "feature/tool",
        expectedRepository: "roshangautam/paperclip-github-bot-identity-plugin"
      },
      { agentId: TOOL_AGENT_ID }
    );

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Push succeeded");
    expect(commands).toHaveLength(2);
    expect(commands[1].args[0]).toBe("-c");
    expect(commands[1].args[1]).toBe("credential.helper=");
    expect(commands[1].args[2]).toBe("push");
    expect(commands[1].args[3]).toBe("https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");
    expect(commands[1].args[4]).toBe("HEAD:refs/heads/feature/tool");
    expect(commands[1].env?.GITHUB_TOKEN).toBe("resolved:github-token-ref");
  });

  it("denies push when expectedRepository does not match resolved remote", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let secretResolveCalls = 0;
    harness.ctx.secrets.resolve = async () => {
      secretResolveCalls += 1;
      return "should-not-be-used";
    };

    __setGitCommandRunnerForTests(async ({ args, env }) => {
      commands.push({ args, env });
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");

    const result = await harness.executeTool(
      "github_bot_push_branch",
      {
        branch: "feature/tool",
        expectedRepository: "roshangautam/some-other-repo"
      },
      { agentId: TOOL_AGENT_ID }
    );

    expect(result.error).toBe(
      "Push denied: repository mismatch. Expected 'roshangautam/some-other-repo', found 'roshangautam/paperclip-github-bot-identity-plugin'."
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].args).toEqual(["remote", "get-url", "origin"]);
    expect(secretResolveCalls).toBe(0);
  });

  it("denies push to disallowed repository before secret resolution", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    let secretResolveCalls = 0;
    harness.ctx.secrets.resolve = async () => {
      secretResolveCalls += 1;
      return "should-not-be-used";
    };

    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://github.com/paperclipai/paperclip.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/paperclipai/paperclip.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });

    expect(result.error).toContain("Push denied");
    expect(secretResolveCalls).toBe(0);
  });

  it("denies non-GitHub remotes before secret resolution", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let secretResolveCalls = 0;
    harness.ctx.secrets.resolve = async () => {
      secretResolveCalls += 1;
      return "should-not-be-used";
    };

    __setGitCommandRunnerForTests(async ({ args, env }) => {
      commands.push({ args, env });
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://gitlab.com/roshangautam/repo.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://gitlab.com/roshangautam/repo.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });

    expect(result.error).toBe("Push denied: remote must be a GitHub repository URL.");
    expect(commands).toHaveLength(1);
    expect(commands[0].args).toEqual(["remote", "get-url", "origin"]);
    expect(secretResolveCalls).toBe(0);
  });

  it("rejects invalid remote parameter before git command execution", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    __setGitCommandRunnerForTests(async ({ args }) => {
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    const result = await harness.executeTool(
      "github_bot_push_branch",
      { branch: "feature/tool", remote: "--all" },
      { agentId: TOOL_AGENT_ID }
    );

    expect(result.error).toBe("Invalid remote. Use a non-empty remote name without whitespace.");
  });

  it("fails when calling agent identity config is missing", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities]
    });
    await plugin.definition.setup(harness.ctx);

    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });
    expect(result.error).toContain("Invalid GitHub bot identity config");
  });

  it("returns a stable error and logs outcome when secret resolution fails", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    const activityLogs: Array<Record<string, unknown>> = [];
    const originalLog = harness.ctx.activity.log;
    harness.ctx.activity.log = async (entry) => {
      activityLogs.push(entry as unknown as Record<string, unknown>);
      await originalLog(entry);
    };

    harness.ctx.secrets.resolve = async () => {
      throw new Error("invalid secret ref");
    };

    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });

    expect(result.error).toBe("Failed to resolve bot authentication credentials.");
    expect(activityLogs).toContainEqual(expect.objectContaining({
      message: "github_bot_push_branch failed: secret resolution",
      metadata: expect.objectContaining({
        outcome: "secret_resolution_failed"
      })
    }));
  });

  it("normalizes ssh protocol remotes via shared repo parser", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "ssh://git@github.com/roshangautam/paperclip-github-bot-identity-plugin.git\n",
          stderr: ""
        };
      }
      if (args[0] === "-c" && args[2] === "push") {
        return {
          exitCode: 0,
          stdout: "pushed\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Push succeeded");
  });

  it("includes --dry-run flag and returns dry-run success message when dryRun is true", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("github-token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    __setGitCommandRunnerForTests(async ({ args, env }) => {
      commands.push({ args, env });
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git\n",
          stderr: ""
        };
      }
      if (args[0] === "-c" && args[2] === "push") {
        return {
          exitCode: 0,
          stdout: "dry-run pushed\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");

    const result = await harness.executeTool(
      "github_bot_push_branch",
      {
        branch: "feature/dry",
        expectedRepository: "roshangautam/paperclip-github-bot-identity-plugin",
        dryRun: true
      },
      { agentId: TOOL_AGENT_ID }
    );

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Dry-run push succeeded");
    expect(commands).toHaveLength(2);
    expect(commands[1].args[0]).toBe("-c");
    expect(commands[1].args[1]).toBe("credential.helper=");
    expect(commands[1].args[2]).toBe("push");
    expect(commands[1].args[3]).toBe("--dry-run");
    expect(commands[1].args[4]).toBe("https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");
    expect(commands[1].args[5]).toBe("HEAD:refs/heads/feature/dry");
  });

  it("redacts resolved token from tool-visible output on push failure", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig("token-ref")
    });
    await plugin.definition.setup(harness.ctx);

    harness.ctx.secrets.resolve = async () => "super-secret-token";

    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git\n",
          stderr: ""
        };
      }
      if (args[0] === "-c" && args[2] === "push") {
        return {
          exitCode: 1,
          stdout: "token was super-secret-token and should be hidden\n",
          stderr: "auth failed with super-secret-token"
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });

    expect(result.error).toContain("git push failed");
    expect(String(result.error)).not.toContain("super-secret-token");
    expect(JSON.stringify(result.data)).not.toContain("super-secret-token");
    expect(JSON.stringify(result.data)).toContain("[REDACTED]");
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

    const saved = await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      agentId: "agent-uuid-123",
      label: "QA Bot",
      githubUsername: "paperclip-qa-bot",
      tokenSecretRef: "GITHUB_QA_BOT_TOKEN",
      allowedOwnerPattern: DEFAULT_ALLOWED_OWNER_PATTERN,
    });

    expect(saved.agentId).toBe("agent-uuid-123");
    expect(saved.label).toBe("QA Bot");
    expect(saved.githubUsername).toBe("paperclip-qa-bot");
    expect(saved.tokenSecretRef).toBe("GITHUB_QA_BOT_TOKEN");
    expect(saved.allowedOwnerPattern).toBe(DEFAULT_ALLOWED_OWNER_PATTERN);

    const config = await harness.getData<BotIdentityConfig>("bot-identity-config");
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

    expect(saved.allowedOwnerPattern).toBe(DEFAULT_ALLOWED_OWNER_PATTERN);
  });

  it("stores optional commit identity fields", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      agentId: "agent-1",
      label: "Deploy Bot",
      githubUsername: "paperclip-deploy",
      tokenSecretRef: "DEPLOY_TOKEN",
      allowedOwnerPattern: DEFAULT_ALLOWED_OWNER_PATTERN,
      commitName: "Paperclip Deploy",
      commitEmail: "deploy@paperclip.ai",
    });

    expect(saved.commitName).toBe("Paperclip Deploy");
    expect(saved.commitEmail).toBe("deploy@paperclip.ai");
  });
});
