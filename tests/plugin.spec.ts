import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin, { DEFAULT_ALLOWED_REPO_PATTERN } from "../src/worker.js";
import { CONFIG_SCOPE } from "../src/config-source.js";
import type { BotIdentityConfig, BotIdentitySettingsData, ConvertGitHubAppManifestResult, CreateGitHubAppManifestResult, GetGitHubAppManifestFlowResult } from "../src/shared/types.js";
import { __resetGitCommandRunnerForTests, __setGitCommandRunnerForTests } from "../src/github-bot-push-branch.js";
import { CREDENTIAL_SIDECAR_PATH_ENV } from "../src/credential-sidecar.js";

afterEach(async () => {
  __resetGitCommandRunnerForTests();
  if (originalCredentialSidecarPath === undefined) {
    delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  } else {
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalCredentialSidecarPath;
  }
  if (credentialSidecarDir) {
    await rm(credentialSidecarDir, { recursive: true, force: true });
    credentialSidecarDir = null;
  }
});

const TOOL_AGENT_ID = "agent-test";
const TEST_SECRET_ID = "00000000-0000-4000-8000-000000000001";
let credentialSidecarDir: string | null = null;
const originalCredentialSidecarPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];

beforeEach(async () => {
  credentialSidecarDir = await mkdtemp(join(tmpdir(), "github-bot-identity-test-"));
  const sidecarPath = join(credentialSidecarDir, "credentials.json");
  process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
  await writeFile(sidecarPath, JSON.stringify({
    version: 1,
    identities: {
      [TOOL_AGENT_ID]: { secretId: TEST_SECRET_ID },
      agent_1: { secretId: TEST_SECRET_ID }
    }
  }), "utf8");
});

function pushToolConfig() {
  return {
    identities: {
      [TOOL_AGENT_ID]: {
        label: "Push Bot",
        githubUsername: "roshan-bot"
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
    expect(manifest.capabilities).toContain("agents.read");
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

  it("lists Paperclip agents for the settings dropdown", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    harness.seed({
      agents: [
        {
          id: "agent-2",
          companyId: "company_1",
          name: "Zulu Bot",
          role: "Engineer",
          title: null,
          status: "idle"
        } as never,
        {
          id: "agent-1",
          companyId: "company_1",
          name: "Alpha Bot",
          role: "QA",
          title: "Quality Pilot",
          status: "paused"
        } as never,
        {
          id: "agent-other-company",
          companyId: "company_2",
          name: "Other Company Bot",
          role: "Ops",
          title: null,
          status: "idle"
        } as never
      ]
    });
    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<{ agents: Array<{ id: string; name: string; title?: string | null }> }>(
      "paperclip-agents",
      { companyId: "company_1" }
    );

    expect(data.agents).toEqual([
      expect.objectContaining({ id: "agent-1", name: "Alpha Bot", title: "Quality Pilot" }),
      expect.objectContaining({ id: "agent-2", name: "Zulu Bot" })
    ]);
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
            allowedRepoPatterns: ["roshangautam/paperclip-github-bot-identity-plugin"],
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
      allowedRepoPatterns: ["roshangautam/paperclip-github-bot-identity-plugin"],
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
            allowedRepoPatterns: ["roshangautam/paperclip-github-bot-identity-plugin"]
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
    expect(whoami.error).toContain("Missing agent identity config");
    expect(whoami.data).toBeUndefined();
    expect(whoami.content).toBeUndefined();
  });

  it("allows mediated push for roshangautam repository", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig()
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
    expect(commands[1].env?.GITHUB_TOKEN).toBe(`resolved:${TEST_SECRET_ID}`);
  });

  it("denies push when expectedRepository does not match resolved remote", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig()
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
      config: pushToolConfig()
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
      config: pushToolConfig()
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
      config: pushToolConfig()
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
    expect(result.error).toContain("Invalid agent identity config");
  });

  it("returns a stable error and logs outcome when secret resolution fails", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig()
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
      message: "github_bot_push_branch failed: credential resolution",
      metadata: expect.objectContaining({
        outcome: "credential_resolution_failed"
      })
    }));
  });

  it("normalizes ssh protocol remotes via shared repo parser", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig()
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
      config: pushToolConfig()
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
      config: pushToolConfig()
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

describe("agent identity settings", () => {
  it("declares settingsPage UI slot", () => {
    const settingsSlot = manifest.ui?.slots?.find(s => s.id === "bot-identity-settings");
    expect(settingsSlot).toBeDefined();
    expect(settingsSlot!.type).toBe("settingsPage");
    expect(settingsSlot!.exportName).toBe("SettingsPage");
  });

  it("returns an empty settings list when nothing is saved", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.version).toBe(2);
    expect(config.identities).toEqual([]);
    expect(config.credentialSidecarPath).toBe(process.env[CREDENTIAL_SIDECAR_PATH_ENV]);
  });

  it("saves and retrieves multiple agent identity configs", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      agentId: "agent-uuid-123",
      label: "QA Bot",
      githubUsername: "paperclip-qa-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
    });
    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      agentId: "agent-uuid-456",
      label: "Deploy Bot",
      githubUsername: "paperclip-deploy-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
    });

    expect(saved.agentId).toBe("agent-uuid-123");
    expect(saved.label).toBe("QA Bot");
    expect(saved.githubUsername).toBe("paperclip-qa-bot");
    expect(saved.allowedRepoPatterns).toEqual([DEFAULT_ALLOWED_REPO_PATTERN]);

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.map((identity) => identity.agentId).sort()).toEqual(["agent-uuid-123", "agent-uuid-456"]);
    expect(config.identities.find((identity) => identity.agentId === "agent-uuid-123")?.githubUsername).toBe("paperclip-qa-bot");
  });

  it("persists GitHub App credential propagation agent selections", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      agentId: "agent-with-env",
      label: "Env Bot",
      githubUsername: "paperclip-env-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
      githubAppCredentialPropagationAgentIds: ["agent-with-env", "agent-reviewer", "agent-with-env"],
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.find((identity) => identity.agentId === "agent-with-env")?.githubAppCredentialPropagationAgentIds)
      .toEqual(["agent-with-env", "agent-reviewer"]);
  });

  it("creates a valid GitHub App manifest without webhook attributes", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      agentId: "agent-manifest",
      label: "Sterling Hale",
    });

    const manifestBody = JSON.parse(result.manifest);
    expect(result.agentId).toBe("agent-manifest");
    expect(result.appName).toBe("Sterling Hale Paperclip Agent");
    expect(result.label).toBe("Sterling Hale");
    expect(result.postUrl).toBe(`https://github.com/settings/apps/new?state=${encodeURIComponent(result.state)}`);
    expect(manifestBody).toMatchObject({
      name: "Sterling Hale Paperclip Agent",
      description: "Paperclip-managed GitHub bot identity for Sterling Hale.",
      url: "https://paperclip.roshangautam.com",
      redirect_url: "https://paperclip.roshangautam.com",
      callback_urls: ["https://paperclip.roshangautam.com"],
      setup_url: expect.stringMatching(/^https:\/\/paperclip\.roshangautam\.com\/?\?githubAppManifest=install&state=pc_/),
      setup_on_update: true,
      request_oauth_on_install: false,
      public: false,
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        issues: "write",
        workflows: "write",
      },
      default_events: [],
    });
    expect(manifestBody.hook_attributes).toBeUndefined();
    expect(manifestBody.default_events).toEqual([]);
  });

  it("uses separate homepage and callback URLs in the GitHub App manifest", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      agentId: "sterling-hale",
      label: "Sterling Hale",
      homepageUrl: "https://paperclip.roshangautam.com/WAT/agents/sterling-hale/dashboard",
      callbackUrl: "https://paperclip.roshangautam.com/WAT/settings?tab=plugins&githubAppManifest=1",
    });

    const manifestBody = JSON.parse(result.manifest);
    expect(manifestBody.url).toBe("https://paperclip.roshangautam.com/WAT/agents/sterling-hale/dashboard");
    expect(manifestBody.redirect_url).toBe("https://paperclip.roshangautam.com/WAT/settings?tab=plugins&githubAppManifest=1");
    expect(manifestBody.callback_urls).toEqual(["https://paperclip.roshangautam.com/WAT/settings?tab=plugins&githubAppManifest=1"]);
    expect(manifestBody.setup_url).toBe(`${result.setupUrl}`);
    expect(manifestBody.setup_url).toContain("githubAppManifest=install");
    expect(manifestBody.setup_url).toContain(`state=${encodeURIComponent(result.state)}`);
  });


  it("returns a stored GitHub App manifest flow by state", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const flow = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      agentId: "agent-manifest",
      label: "Sterling Hale",
    });

    const restored = await harness.performAction<GetGitHubAppManifestFlowResult>("get-github-app-manifest-flow", {
      state: flow.state,
    });

    expect(restored).toEqual(flow);
  });

  it("converts a GitHub App manifest code and stores the generated private key file", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const flow = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      agentId: "agent-manifest",
      label: "Sterling Hale",
    });
    const fetchSpy = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        id: 12345,
        slug: "sterling-hale-paperclip-agent",
        name: "Sterling Hale Paperclip Agent",
        pem: "-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----",
      }), { status: 201 }),
    );

    const result = await harness.performAction<ConvertGitHubAppManifestResult>("convert-github-app-manifest", {
      state: flow.state,
      code: "one-time-code",
    });

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/one-time-code/conversions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result).toEqual({
      agentId: "agent-manifest",
      appId: "12345",
      appSlug: "sterling-hale-paperclip-agent",
      appName: "Sterling Hale Paperclip Agent",
      githubUsername: "sterling-hale-paperclip-agent[bot]",
      privateKeyFile: join(credentialSidecarDir!, "github-apps", "agent-manifest", "private-key.pem"),
      installUrl: `https://github.com/apps/sterling-hale-paperclip-agent/installations/new?state=${encodeURIComponent(flow.state)}`,
    });
    await expect(readFile(result.privateKeyFile, "utf8")).resolves.toBe("-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----\n");

    const restored = await harness.performAction<GetGitHubAppManifestFlowResult>("get-github-app-manifest-flow", {
      state: flow.state,
    });
    expect(restored.conversion).toEqual(result);
  });

  it("writes GitHub App credential references to the sidecar on save", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("save-bot-identity-config", {
      agentId: "agent-with-github-app",
      label: "GitHub App Bot",
      githubUsername: "paperclip-github-app-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
      githubAppCredentialPropagationAgentIds: ["agent-with-github-app"],
      credential: {
        githubApp: {
          appId: "12345",
          installationId: "67890",
          privateKeySecretId: TEST_SECRET_ID,
          privateKeyFile: "/paperclip/.paperclip/github-bot-identity/github-apps/agent-with-github-app/private-key.pem",
        },
      },
    });

    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-with-github-app"]).toEqual({
      githubApp: {
        appId: "12345",
        installationId: "67890",
        privateKeySecretId: TEST_SECRET_ID,
        privateKeyFile: "/paperclip/.paperclip/github-bot-identity/github-apps/agent-with-github-app/private-key.pem",
      },
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    const entry = config.identities.find((identity) => identity.agentId === "agent-with-github-app");
    expect(entry?.credentialStatus).toBe("configured");
    expect(entry?.githubAppCredentialPropagationAgentIds).toEqual(["agent-with-github-app"]);
  });

  it("writes credential references to the sidecar on save", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("save-bot-identity-config", {
      agentId: "agent-with-credential",
      label: "Credential Bot",
      githubUsername: "paperclip-credential-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
      credential: {
        secretId: TEST_SECRET_ID,
        tokenFile: "/paperclip/.paperclip/github-bot-identity/tokens/agent-with-credential.token",
      },
    });

    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-with-credential"]).toEqual({
      secretId: TEST_SECRET_ID,
      tokenFile: "/paperclip/.paperclip/github-bot-identity/tokens/agent-with-credential.token",
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.find((identity) => identity.agentId === "agent-with-credential")?.credentialStatus).toBe("configured");
  });

  it("deletes agent identity config and matching sidecar entry", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("save-bot-identity-config", {
      agentId: "agent-delete-me",
      label: "Delete Bot",
      githubUsername: "paperclip-delete-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
      credential: { secretId: TEST_SECRET_ID },
    });
    await harness.performAction("delete-bot-identity-config", { agentId: "agent-delete-me" });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.some((identity) => identity.agentId === "agent-delete-me")).toBe(false);
    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-delete-me"]).toBeUndefined();
  });

  it("uses legacy single-agent settings state for agent tools", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      agentId: "legacy-agent",
      label: "Legacy Bot",
      githubUsername: "paperclip-legacy-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
    });

    const whoami = await harness.executeTool<{ data?: Record<string, unknown>; error?: string }>(
      "github_bot_whoami",
      {},
      { agentId: "legacy-agent" }
    );

    expect(whoami.error).toBeUndefined();
    expect(whoami.data).toEqual(expect.objectContaining({
      label: "Legacy Bot",
      githubUsername: "paperclip-legacy-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN]
    }));
  });

  it("uses settings-page state for agent tools when instance config is empty", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      agentId: "agent-from-settings",
      label: "Settings Bot",
      githubUsername: "paperclip-settings-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
    });

    const whoami = await harness.executeTool<{ data?: Record<string, unknown>; error?: string }>(
      "github_bot_whoami",
      {},
      { agentId: "agent-from-settings" }
    );

    expect(whoami.error).toBeUndefined();
    expect(whoami.data).toEqual(expect.objectContaining({
      label: "Settings Bot",
      githubUsername: "paperclip-settings-bot",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN]
    }));
  });

  it("rejects save when required fields are missing", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction("save-bot-identity-config", {
        agentId: "",
        label: "Test",
        githubUsername: "bot",
      })
    ).rejects.toThrow("Required fields");
  });

  it("defaults allowedRepoPatterns when omitted", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<{ allowedRepoPatterns: string[] }>(
      "save-bot-identity-config",
      {
        agentId: "agent-1",
        label: "Test",
        githubUsername: "bot",
        allowedOwnerPattern: "",
      }
    );

    expect(saved.allowedRepoPatterns).toEqual([DEFAULT_ALLOWED_REPO_PATTERN]);
  });

  it("stores optional commit identity fields", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      agentId: "agent-1",
      label: "Deploy Bot",
      githubUsername: "paperclip-deploy",
      allowedRepoPatterns: [DEFAULT_ALLOWED_REPO_PATTERN],
      commitName: "Paperclip Deploy",
      commitEmail: "deploy@paperclip.ai",
    });

    expect(saved.commitName).toBe("Paperclip Deploy");
    expect(saved.commitEmail).toBe("deploy@paperclip.ai");
  });
});
