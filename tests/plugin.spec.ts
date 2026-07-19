import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsActionTestHarness as createTestHarness } from "./helpers/settings-action-harness.js";
import manifest, { SETTINGS_ACTIONS } from "../src/manifest.js";
import plugin from "../src/worker.js";
import { CONFIG_SCOPE } from "../src/config-source.js";
import type { BotIdentityConfig, BotIdentitySettingsData, ConvertGitHubAppManifestResult, CreateGitHubAppManifestResult, GetGitHubAppManifestFlowResult } from "../src/shared/types.js";
import {
  __resetGitCommandRunnerForTests,
  __setGitCommandRunnerForTests,
} from "../src/providers/github/tools/push-branch.js";
import { CREDENTIAL_SIDECAR_PATH_ENV } from "../src/credential-sidecar.js";
import { getGitHubAppPrivateKeyFile } from "../src/ui/SettingsPage.js";

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
const TEST_SECRET_ID_2 = "00000000-0000-4000-8000-000000000002";
let credentialSidecarDir: string | null = null;
const originalCredentialSidecarPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];

beforeEach(async () => {
  credentialSidecarDir = await mkdtemp(join(tmpdir(), "agent-identities-test-"));
  const sidecarPath = join(credentialSidecarDir, "credentials.json");
  process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
  await writeFile(sidecarPath, JSON.stringify({
    version: 1,
    identities: {
      [`${TOOL_AGENT_ID}:github`]: { secretId: TEST_SECRET_ID },
      "agent_1:github": { secretId: TEST_SECRET_ID }
    }
  }), "utf8");
});

function pushToolConfig() {
  return {
    identities: {
      [TOOL_AGENT_ID]: {
        label: "Push Bot",
        githubUsername: "paperclip-push-bot",
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
    expect(manifest.capabilities).toContain("events.emit");
    expect(manifest.capabilities).toContain("ui.dashboardWidget.register");
    expect(manifest.capabilities).toContain("agent.tools.register");
    expect(manifest.capabilities).toContain("agents.read");
    expect(manifest.capabilities).toContain("companies.read");
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

  it("declares the settings action contract, including released Slack credential recovery", () => {
    expect(SETTINGS_ACTIONS).toContain("rebind-legacy-slack-credentials");
    expect(SETTINGS_ACTIONS).toEqual(expect.arrayContaining([
      "create-github-app-manifest",
      "get-github-app-manifest-flow",
      "convert-github-app-manifest",
    ]));
    expect(new Set(SETTINGS_ACTIONS).size).toBe(SETTINGS_ACTIONS.length);
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


  it("returns the full company name for settings labels", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    harness.seed({
      companies: [
        {
          id: "company-dro",
          name: "DRO",
          issuePrefix: "DRO",
          status: "active",
        } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);

    const data = await harness.getData<BotIdentitySettingsData>("bot-identity-config", { companyId: "company-dro" });

    expect(data.companyName).toBe("DRO");
  });

  it("returns a safe identity summary for configured agents", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          agent_1: {
            label: "Example CTO",
            githubUsername: "paperclip-kiln-lathe",
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
      label: "Example CTO",
      githubUsername: "paperclip-kiln-lathe",
      hasCommitName: true,
      hasCommitEmail: true
    });
    expect(whoami.content).toContain("Example CTO");
    expect(whoami.content).toContain("@paperclip-kiln-lathe");
    expect(whoami.data?.token).toBeUndefined();
  });

  it("fails closed for unconfigured agents", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: {
        identities: {
          agent_1: {
            label: "Example CTO",
            githubUsername: "paperclip-kiln-lathe",
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
    expect(whoami.error).toContain("Required");
    expect(whoami.data).toBeUndefined();
    expect(whoami.content).toBeUndefined();
  });

  it("allows mediated push for a configured repository", async () => {
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
          stdout: "git@github.com:my-org/example-repo.git\n",
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

    seedPrimaryWorkspace(harness, "https://github.com/my-org/example-repo.git");

    const result = await harness.executeTool(
      "github_bot_push_branch",
      {
        branch: "feature/tool",
        expectedRepository: "my-org/example-repo"
      },
      { agentId: TOOL_AGENT_ID }
    );

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Push succeeded");
    expect(commands).toHaveLength(2);
    expect(commands[1].args[0]).toBe("-c");
    expect(commands[1].args[1]).toBe("credential.helper=");
    expect(commands[1].args[2]).toBe("push");
    expect(commands[1].args[3]).toBe("https://github.com/my-org/example-repo.git");
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
          stdout: "https://github.com/my-org/example-repo.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/my-org/example-repo.git");

    const result = await harness.executeTool(
      "github_bot_push_branch",
      {
        branch: "feature/tool",
        expectedRepository: "my-org/some-other-repo"
      },
      { agentId: TOOL_AGENT_ID }
    );

    expect(result.error).toBe(
      "Push denied: repository mismatch. Expected 'my-org/some-other-repo', found 'my-org/example-repo'."
    );
    expect(commands).toHaveLength(1);
    expect(commands[0].args).toEqual(["remote", "get-url", "origin"]);
    expect(secretResolveCalls).toBe(0);
  });

  it("allows GitHub remotes with provider-controlled access", async () => {
    const harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities],
      config: pushToolConfig()
    });
    await plugin.definition.setup(harness.ctx);

    const commands: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let secretResolveCalls = 0;
    harness.ctx.secrets.resolve = async (
      secretRef: string | { type: "secret_ref"; secretId: string; version?: "latest" },
    ) => {
      secretResolveCalls += 1;
      return `resolved:${typeof secretRef === "string" ? secretRef : secretRef.secretId}`;
    };

    __setGitCommandRunnerForTests(async ({ args, env }) => {
      commands.push({ args, env });
      if (args[0] === "remote" && args[1] === "get-url") {
        return {
          exitCode: 0,
          stdout: "https://github.com/paperclipai/paperclip.git\n",
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

    seedPrimaryWorkspace(harness, "https://github.com/paperclipai/paperclip.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Push succeeded");
    expect(secretResolveCalls).toBe(1);
    expect(commands[1].args[3]).toBe("https://github.com/paperclipai/paperclip.git");
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
          stdout: "https://gitlab.com/my-org/repo.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://gitlab.com/my-org/repo.git");

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
          stdout: "https://github.com/my-org/example-repo.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/my-org/example-repo.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });
    expect(result.error).toContain("failed closed");
    expect(result.error).toContain("Required");
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
          stdout: "https://github.com/my-org/example-repo.git\n",
          stderr: ""
        };
      }
      throw new Error(`Unexpected git command: ${args.join(" ")}`);
    });

    seedPrimaryWorkspace(harness, "https://github.com/my-org/example-repo.git");

    const result = await harness.executeTool("github_bot_push_branch", { branch: "feature/tool" }, { agentId: TOOL_AGENT_ID });

    expect(result.error).toBe("Failed to resolve agent identity authentication credentials.");
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
          stdout: "ssh://git@github.com/my-org/example-repo.git\n",
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

    seedPrimaryWorkspace(harness, "https://github.com/my-org/example-repo.git");

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
          stdout: "https://github.com/my-org/example-repo.git\n",
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

    seedPrimaryWorkspace(harness, "https://github.com/my-org/example-repo.git");

    const result = await harness.executeTool(
      "github_bot_push_branch",
      {
        branch: "feature/dry",
        expectedRepository: "my-org/example-repo",
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
    expect(commands[1].args[4]).toBe("https://github.com/my-org/example-repo.git");
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
          stdout: "https://github.com/my-org/example-repo.git\n",
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

    seedPrimaryWorkspace(harness, "https://github.com/my-org/example-repo.git");

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
    expect(config.version).toBe(5);
    expect(config.providers.map((provider) => provider.id)).toContain("github");
    expect(config.identities).toEqual([]);
    expect(config.credentialSidecarPath).toBe(process.env[CREDENTIAL_SIDECAR_PATH_ENV]);
  });

  it("returns supported identity providers with current availability", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");

    expect(config.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "github", name: "GitHub", status: "enabled" }),
      expect.objectContaining({ id: "slack", name: "Slack", status: "coming-soon" }),
      expect.objectContaining({ id: "mattermost", name: "Mattermost", status: "coming-soon" }),
      expect.objectContaining({ id: "entra", name: "Microsoft Entra", status: "coming-soon" }),
      expect.objectContaining({ id: "gcp", name: "Google Cloud", status: "coming-soon" }),
      expect.objectContaining({ id: "aws", name: "AWS", status: "coming-soon" }),
    ]));
  });

  it("rejects identities for providers that are not enabled yet", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction("save-bot-identity-config", {
      provider: "slack",
      agentId: "agent-slack",
      label: "Slack Identity",
      github: { username: "slack-agent" },
    })).rejects.toThrow("Slack identities are not supported yet.");
  });

  it("saves and retrieves multiple agent identity configs", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-uuid-123",
      label: "QA Bot",
      github: { username: "paperclip-qa-bot" },
    });
    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-uuid-456",
      label: "Deploy Bot",
      github: { username: "paperclip-deploy-bot" },
    });

    expect(saved.agentId).toBe("agent-uuid-123");
    expect(saved.label).toBe("QA Bot");
    expect(saved.provider).toBe("github");
    expect(saved.provider === "github" && saved.github.username).toBe("paperclip-qa-bot");
    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.map((identity) => identity.agentId).sort()).toEqual(["agent-uuid-123", "agent-uuid-456"]);
    const qaEntry = config.identities.find((identity) => identity.agentId === "agent-uuid-123");
    expect(qaEntry?.provider === "github" && qaEntry.github.username).toBe("paperclip-qa-bot");
  });

  it("filters configured identities to the current settings company", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    harness.seed({
      agents: [
        { id: "agent-company-1", companyId: "company_1", name: "Company One Bot" } as never,
        { id: "agent-company-2", companyId: "company_2", name: "Company Two Bot" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-company-1",
      label: "Company One Identity",
      github: { username: "company-one-bot" },
    }, { companyId: "company_1" });
    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-company-2",
      label: "Company Two Identity",
      github: { username: "company-two-bot" },
    }, { companyId: "company_2" });

    const companyOneConfig = await harness.getData<BotIdentitySettingsData>("bot-identity-config", { companyId: "company_1" });
    const companyTwoConfig = await harness.getData<BotIdentitySettingsData>("bot-identity-config", { companyId: "company_2" });
    const unscopedConfig = await harness.getData<BotIdentitySettingsData>("bot-identity-config");

    expect(companyOneConfig.identities.map((identity) => identity.agentId)).toEqual(["agent-company-1"]);
    expect(companyTwoConfig.identities.map((identity) => identity.agentId)).toEqual(["agent-company-2"]);
    expect(unscopedConfig.identities.map((identity) => identity.agentId).sort()).toEqual(["agent-company-1", "agent-company-2"]);
  });

  it("does not expose configured identities when the scoped company has no agents", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-with-saved-config",
      label: "Saved Identity",
      github: { username: "saved-identity-bot" },
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config", { companyId: "company-with-empty-agent-list" });

    expect(config.identities).toEqual([]);
  });

  it("persists GitHub App credential propagation agent selections", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-with-env",
      label: "Env Bot",
      github: {
        username: "paperclip-env-bot",
        app: { credentialPropagationAgentIds: ["agent-with-env", "agent-reviewer", "agent-with-env"] },
      },
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    const envEntry = config.identities.find((identity) => identity.agentId === "agent-with-env");
    expect(envEntry?.provider === "github" && envEntry.github.app?.credentialPropagationAgentIds)
      .toEqual(["agent-with-env", "agent-reviewer"]);
  });

  it("creates a valid GitHub App manifest without webhook attributes", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      provider: "github",
      agentId: "agent-manifest",
      label: "Sterling Hale",
    });

    const manifestBody = JSON.parse(result.manifest);
    expect(result.provider).toBe("github");
    expect(result.agentId).toBe("agent-manifest");
    expect(result.appName).toBe("Sterling Hale Paperclip Agent");
    expect(result.label).toBe("Sterling Hale");
    expect(result.postUrl).toBe(`https://github.com/settings/apps/new?state=${encodeURIComponent(result.state)}`);
    expect(manifestBody).toMatchObject({
      name: "Sterling Hale Paperclip Agent",
      description: "Paperclip-managed GitHub App identity provider for Sterling Hale.",
      url: "https://paperclip.example.com",
      redirect_url: "https://paperclip.example.com",
      callback_urls: ["https://paperclip.example.com"],
      setup_url: expect.stringMatching(/^https:\/\/paperclip\.example\.com\/?\?githubAppManifest=install&state=pc_/),
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
      homepageUrl: "https://paperclip.example.com/WAT/agents/sterling-hale/dashboard",
      callbackUrl: "https://paperclip.example.com/WAT/settings?tab=plugins&githubAppManifest=1",
    });

    const manifestBody = JSON.parse(result.manifest);
    expect(manifestBody.url).toBe("https://paperclip.example.com/WAT/agents/sterling-hale/dashboard");
    expect(manifestBody.redirect_url).toBe("https://paperclip.example.com/WAT/settings?tab=plugins&githubAppManifest=1");
    expect(manifestBody.callback_urls).toEqual(["https://paperclip.example.com/WAT/settings?tab=plugins&githubAppManifest=1"]);
    expect(manifestBody.setup_url).toBe(`${result.setupUrl}`);
    expect(manifestBody.setup_url).toContain("githubAppManifest=install");
    expect(manifestBody.setup_url).toContain(`state=${encodeURIComponent(result.state)}`);
  });

  it("rejects GitHub App manifest agent IDs that are not a single path segment", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      provider: "github",
      agentId: "../agent-manifest",
      label: "Sterling Hale",
    })).rejects.toThrow("agentId must be a single path segment.");

    await expect(harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      provider: "github",
      agentId: "nested/agent-manifest",
      label: "Sterling Hale",
    })).rejects.toThrow("agentId must be a single path segment.");
  });


  it("returns a stored GitHub App manifest flow by state", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const flow = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      provider: "github",
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
      provider: "github",
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
      provider: "github",
      agentId: "agent-manifest",
      appId: "12345",
      appSlug: "sterling-hale-paperclip-agent",
      appName: "Sterling Hale Paperclip Agent",
      githubUsername: "sterling-hale-paperclip-agent[bot]",
      privateKeyFile: join(credentialSidecarDir!, "github-apps", "agent-manifest", "private-key.pem"),
      installUrl: `https://github.com/apps/sterling-hale-paperclip-agent/installations/new?state=${encodeURIComponent(flow.state)}`,
    });
    await expect(readFile(result.privateKeyFile, "utf8")).resolves.toBe("-----BEGIN RSA PRIVATE KEY-----\ntest-key\n-----END RSA PRIVATE KEY-----\n");
    await expect(stat(result.privateKeyFile).then((value) => value.mode & 0o777)).resolves.toBe(0o600);

    await expect(harness.performAction<GetGitHubAppManifestFlowResult>("get-github-app-manifest-flow", {
      state: flow.state,
    })).resolves.toEqual({ ...flow, conversion: result });

    await expect(harness.performAction<ConvertGitHubAppManifestResult>("convert-github-app-manifest", {
      state: flow.state,
      code: "one-time-code",
    })).resolves.toEqual(result);
    expect(fetchSpy).toHaveBeenCalledOnce();

    await expect(harness.performAction<GetGitHubAppManifestFlowResult>("get-github-app-manifest-flow", {
      state: flow.state,
      consume: true,
    })).resolves.toEqual({ ...flow, conversion: result });
    await expect(harness.performAction<GetGitHubAppManifestFlowResult>("get-github-app-manifest-flow", {
      state: flow.state,
    })).rejects.toThrow("Unknown or expired GitHub App manifest flow state.");
  });

  it("checks the private-key destination before consuming a manifest code", async () => {
    const blockedPath = join(credentialSidecarDir!, "not-a-directory");
    await writeFile(blockedPath, "blocked", "utf8");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = join(blockedPath, "credentials.json");

    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);
    const flow = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      provider: "github",
      agentId: "agent-manifest",
      label: "Sterling Hale",
    });
    const fetchSpy = vi.spyOn(harness.ctx.http, "fetch");

    await expect(harness.performAction<ConvertGitHubAppManifestResult>("convert-github-app-manifest", {
      state: flow.state,
      code: "must-not-be-consumed",
    })).rejects.toThrow("Unable to prepare GitHub App private-key destination");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a non-file private-key target before consuming a manifest code", async () => {
    const privateKeyFile = join(
      credentialSidecarDir!,
      "github-apps",
      "agent-manifest",
      "private-key.pem",
    );
    await mkdir(privateKeyFile, { recursive: true });

    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);
    const flow = await harness.performAction<CreateGitHubAppManifestResult>("create-github-app-manifest", {
      provider: "github",
      agentId: "agent-manifest",
      label: "Sterling Hale",
    });
    const fetchSpy = vi.spyOn(harness.ctx.http, "fetch");

    await expect(harness.performAction<ConvertGitHubAppManifestResult>("convert-github-app-manifest", {
      state: flow.state,
      code: "must-not-be-consumed",
    })).rejects.toThrow("is not a regular file");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes GitHub App credential references to the sidecar on save", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-with-github-app",
      label: "GitHub App Bot",
      github: {
        username: "paperclip-github-app-bot",
        app: { credentialPropagationAgentIds: ["agent-with-github-app"] },
      },
      credential: {
        githubApp: {
          appId: "12345",
          installationId: "67890",
          privateKeySecretId: TEST_SECRET_ID,
          privateKeyFile: "/paperclip/.paperclip/agent-identities/github-apps/agent-with-github-app/private-key.pem",
        },
      },
    });

    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-with-github-app:github"]).toEqual({
      githubApp: {
        appId: "12345",
        installationId: "67890",
        privateKeySecretId: TEST_SECRET_ID,
        privateKeyFile: "/paperclip/.paperclip/agent-identities/github-apps/agent-with-github-app/private-key.pem",
      },
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    const entry = config.identities.find((identity) => identity.agentId === "agent-with-github-app");
    expect(entry?.credentialStatus).toBe("configured");
    expect(entry?.provider === "github" && entry.github.app?.credentialPropagationAgentIds).toEqual(["agent-with-github-app"]);
  });

  it("writes credential references to the sidecar on save", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-with-credential",
      label: "Credential Bot",
      github: { username: "paperclip-credential-bot" },
      credential: {
        secretId: TEST_SECRET_ID,
        tokenFile: "/paperclip/.paperclip/agent-identities/tokens/agent-with-credential.token",
      },
    });

    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-with-credential:github"]).toEqual({
      secretId: TEST_SECRET_ID,
      tokenFile: "/paperclip/.paperclip/agent-identities/tokens/agent-with-credential.token",
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.find((identity) => identity.agentId === "agent-with-credential")?.credentialStatus).toBe("configured");
  });

  it("moves an edited identity to the selected agent without leaving the old key", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-before-move",
      label: "Move Bot",
      github: { username: "paperclip-move-bot" },
      credential: { secretId: TEST_SECRET_ID },
    });
    await harness.performAction("save-bot-identity-config", {
      provider: "github",
      previousAgentId: "agent-before-move",
      agentId: "agent-after-move",
      label: "Move Bot",
      github: { username: "paperclip-move-bot" },
      credential: { secretId: TEST_SECRET_ID_2 },
    });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.map((identity) => identity.agentId)).toEqual(["agent-after-move"]);
    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-before-move:github"]).toBeUndefined();
    expect(sidecar.identities["agent-after-move:github"]).toEqual({ secretId: TEST_SECRET_ID_2 });
  });

  it("deletes agent identity config and matching sidecar entry", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-delete-me",
      label: "Delete Bot",
      github: { username: "paperclip-delete-bot" },
      credential: { secretId: TEST_SECRET_ID },
    });
    await harness.performAction("delete-bot-identity-config", { provider: "github",
      agentId: "agent-delete-me" });

    const config = await harness.getData<BotIdentitySettingsData>("bot-identity-config");
    expect(config.identities.some((identity) => identity.agentId === "agent-delete-me")).toBe(false);
    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-delete-me:github"]).toBeUndefined();
  });

  it("deletes only the selected Slack subtree and preserves GitHub config without a sidecar", async () => {
    const preservedSlackConfig = {
      label: "Preserved Slack Bot",
      teamId: "T12345678",
      appId: "A12345678",
      botUserId: "U12345678",
      credentials: {
        botToken: { type: "secret_ref", secretId: TEST_SECRET_ID, version: "latest" },
        signingSecret: { type: "secret_ref", secretId: TEST_SECRET_ID_2, version: "latest" },
      },
    };
    let companyConfig: Record<string, unknown> = {
      identities: {
        "agent-delete-slack": {
          label: "Delete GitHub Bot",
          githubUsername: "delete-github[bot]",
          slack: {
            ...preservedSlackConfig,
            label: "Delete Slack Bot",
          },
        },
        "agent-preserve-slack": { slack: preservedSlackConfig },
      },
    };
    const patchSecretRefs = vi.fn(async (input: {
      companyId?: string;
      path: string[];
      value: Record<string, unknown> | null;
    }) => {
      if (input.companyId !== "company_1") throw new Error("Unexpected company scope.");
      const identities = {
        ...(companyConfig.identities as Record<string, unknown>),
      };
      const agentId = input.path[1];
      if (
        input.value === null &&
        input.path[0] === "identities" &&
        agentId &&
        input.path[2] === "slack"
      ) {
        const identity = { ...(identities[agentId] as Record<string, unknown>) };
        delete identity.slack;
        identities[agentId] = identity;
      }
      companyConfig = { ...companyConfig, identities };
    });
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    Object.assign(harness.ctx.config, {
      get: vi.fn(async (companyId?: string) => companyId === "company_1" ? structuredClone(companyConfig) : {}),
      patchSecretRefs,
    });
    harness.seed({
      agents: [
        { id: "agent-delete-slack", companyId: "company_1", name: "Delete Slack Bot" } as never,
        { id: "agent-preserve-slack", companyId: "company_1", name: "Preserved Slack Bot" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-delete-slack:slack": {
          provider: "slack",
          id: "agent-delete-slack:slack",
          agentId: "agent-delete-slack",
          label: "Delete Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
        "agent-preserve-slack:slack": {
          provider: "slack",
          id: "agent-preserve-slack:slack",
          agentId: "agent-preserve-slack",
          label: "Preserved Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
      },
    });

    await writeFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "not valid JSON", "utf8");
    const result = await harness.performAction<BotIdentitySettingsData>(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-delete-slack" },
      { companyId: "company_1" },
    );

    expect(patchSecretRefs).toHaveBeenCalledOnce();
    expect(patchSecretRefs).toHaveBeenCalledWith({
      companyId: "company_1",
      path: ["identities", "agent-delete-slack", "slack"],
      value: null,
    });
    expect(companyConfig).toEqual({
      identities: {
        "agent-delete-slack": {
          label: "Delete GitHub Bot",
          githubUsername: "delete-github[bot]",
        },
        "agent-preserve-slack": { slack: preservedSlackConfig },
      },
    });
    expect(result.identities.map((identity) => identity.agentId)).toEqual(["agent-preserve-slack"]);
    expect(harness.getState(CONFIG_SCOPE)).toEqual({
      version: 5,
      cleanupTombstones: {
        "legacy-slack-sidecar:company_1:agent-delete-slack": {
          version: 1,
          cleanupId: "legacy-slack-sidecar:company_1:agent-delete-slack",
          provider: "slack",
          companyId: "company_1",
          agentId: "agent-delete-slack",
          operation: "legacy-sidecar-delete",
          source: "identity-delete",
        },
      },
      identities: {
        "agent-preserve-slack:slack": {
          provider: "slack",
          id: "agent-preserve-slack:slack",
          agentId: "agent-preserve-slack",
          label: "Preserved Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
      },
    });

    await harness.performAction(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-preserve-slack" },
      { companyId: "company_1" },
    );
    expect(patchSecretRefs).toHaveBeenLastCalledWith({
      companyId: "company_1",
      path: ["identities", "agent-preserve-slack", "slack"],
      value: null,
    });
    expect(companyConfig).toHaveProperty("identities.agent-preserve-slack", {});
  });

  it("deletes the flat Slack config persisted by earlier builds of this PR", async () => {
    const legacySlackConfig = {
      label: "Legacy Slack Bot",
      teamId: "T12345678",
      appId: "A12345678",
      botUserId: "U12345678",
      credentials: {
        botToken: { type: "secret_ref", secretId: TEST_SECRET_ID, version: "latest" },
        signingSecret: { type: "secret_ref", secretId: TEST_SECRET_ID_2, version: "latest" },
      },
    };
    const githubConfig = { label: "Preserved GitHub Bot", githubUsername: "preserved[bot]" };
    let companyConfig: Record<string, unknown> = {
      identities: {
        "agent-legacy-slack": legacySlackConfig,
        "agent-github": githubConfig,
      },
    };
    const patchSecretRefs = vi.fn(async (input: { path: string[]; value: Record<string, unknown> | null }) => {
      const identities = { ...(companyConfig.identities as Record<string, unknown>) };
      if (input.value === null && input.path[0] === "identities" && input.path[1]) {
        delete identities[input.path[1]];
      }
      companyConfig = { ...companyConfig, identities };
    });
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    Object.assign(harness.ctx.config, {
      get: vi.fn(async () => structuredClone(companyConfig)),
      patchSecretRefs,
    });
    harness.seed({
      agents: [{ id: "agent-legacy-slack", companyId: "company_1", name: "Legacy Slack Bot" } as never],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-legacy-slack:slack": {
          provider: "slack",
          id: "agent-legacy-slack:slack",
          agentId: "agent-legacy-slack",
          label: "Legacy Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
      },
    });
    await harness.performAction(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-legacy-slack" },
      { companyId: "company_1" },
    );

    expect(patchSecretRefs).toHaveBeenCalledWith({
      companyId: "company_1",
      path: ["identities", "agent-legacy-slack"],
      value: null,
    });
    expect(companyConfig).toEqual({
      identities: { "agent-github": githubConfig },
    });
  });

  it("deletes a released Slack sidecar entry after host/state deletion and preserves GitHub entries", async () => {
    await writeFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, JSON.stringify({
      version: 1,
      identities: {
        "agent-delete-legacy:slack": {
          slackBotToken: { botTokenSecretId: TEST_SECRET_ID },
        },
        "agent-delete-legacy:github": { secretId: TEST_SECRET_ID_2 },
      },
    }), "utf8");
    let companyConfig: Record<string, unknown> = {
      identities: {
        "agent-delete-legacy": {
          githubUsername: "preserved[bot]",
          slack: {
            label: "Legacy Slack Bot",
            teamId: "T12345678",
            appId: "A12345678",
            botUserId: "U12345678",
            credentials: {
              botToken: { type: "secret_ref", secretId: TEST_SECRET_ID, version: "latest" },
              signingSecret: { type: "secret_ref", secretId: TEST_SECRET_ID_2, version: "latest" },
            },
          },
        },
      },
    };
    const patchSecretRefs = vi.fn(async (input: { path: string[]; value: Record<string, unknown> | null }) => {
      if (input.value === null) {
        const identities = { ...(companyConfig.identities as Record<string, unknown>) };
        const identity = { ...(identities["agent-delete-legacy"] as Record<string, unknown>) };
        delete identity.slack;
        identities["agent-delete-legacy"] = identity;
        companyConfig = { identities };
      }
    });
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    Object.assign(harness.ctx.config, {
      get: vi.fn(async () => structuredClone(companyConfig)),
      patchSecretRefs,
    });
    harness.seed({
      agents: [{ id: "agent-delete-legacy", companyId: "company_1", name: "Legacy Slack Bot" } as never],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-delete-legacy:slack": {
          provider: "slack",
          id: "agent-delete-legacy:slack",
          agentId: "agent-delete-legacy",
          label: "Legacy Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
      },
    });

    await harness.performAction(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-delete-legacy" },
      { companyId: "company_1" },
    );

    expect(companyConfig).toEqual({
      identities: { "agent-delete-legacy": { githubUsername: "preserved[bot]" } },
    });
    expect(JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"))).toEqual({
      version: 1,
      identities: {
        "agent-delete-legacy:github": { secretId: TEST_SECRET_ID_2 },
      },
    });
  });

  it("returns cleanup-pending after successful Slack host/state deletion when legacy sidecar cleanup fails", async () => {
    await writeFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, JSON.stringify({
      version: 1,
      identities: {
        "agent-delete-pending:slack": {
          slackBotToken: { botTokenSecretId: TEST_SECRET_ID },
        },
      },
    }), "utf8");
    let companyConfig: Record<string, unknown> = {
      identities: {
        "agent-delete-pending": {
          slack: {
            label: "Pending Slack Bot",
            teamId: "T12345678",
            appId: "A12345678",
            botUserId: "U12345678",
            credentials: {
              botToken: { type: "secret_ref", secretId: TEST_SECRET_ID, version: "latest" },
              signingSecret: { type: "secret_ref", secretId: TEST_SECRET_ID_2, version: "latest" },
            },
          },
        },
      },
    };
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    Object.assign(harness.ctx.config, {
      get: vi.fn(async () => structuredClone(companyConfig)),
      patchSecretRefs: vi.fn(async (input: { value: Record<string, unknown> | null }) => {
        if (input.value === null) {
          companyConfig = { identities: { "agent-delete-pending": {} } };
        }
      }),
    });
    harness.seed({
      agents: [{ id: "agent-delete-pending", companyId: "company_1", name: "Pending Slack Bot" } as never],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-delete-pending:slack": {
          provider: "slack",
          id: "agent-delete-pending:slack",
          agentId: "agent-delete-pending",
          label: "Pending Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
      },
    });
    const originalStateSet = harness.ctx.state.set.bind(harness.ctx.state);
    let failCleanup = false;
    vi.spyOn(harness.ctx.state, "set").mockImplementation(async (scope, value) => {
      await originalStateSet(scope, value);
      if (
        !failCleanup
        && scope.scopeKind === "instance"
        && scope.stateKey === CONFIG_SCOPE.stateKey
        && Object.keys((value as { identities?: Record<string, unknown> }).identities ?? {}).length === 0
      ) {
        failCleanup = true;
        await chmod(credentialSidecarDir!, 0o500);
      }
    });

    const result = await harness.performAction<BotIdentitySettingsData>(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-delete-pending" },
      { companyId: "company_1" },
    ).finally(async () => await chmod(credentialSidecarDir!, 0o700));

    expect(result.identities).toEqual([]);
    expect(result.cleanupPending).toContainEqual(expect.objectContaining({
      provider: "slack",
      agentId: "agent-delete-pending",
      operation: "legacy-sidecar-delete",
    }));
    expect(companyConfig).toEqual({ identities: { "agent-delete-pending": {} } });
    expect(harness.getState(CONFIG_SCOPE)).toEqual({
      version: 5,
      identities: {},
      cleanupTombstones: {
        "legacy-slack-sidecar:company_1:agent-delete-pending": expect.objectContaining({
          provider: "slack",
          companyId: "company_1",
          agentId: "agent-delete-pending",
          operation: "legacy-sidecar-delete",
        }),
      },
    });
  });

  it("does not interpret a malformed GitHub identity as legacy Slack config", async () => {
    const malformedGitHubConfig = {
      label: "Malformed GitHub Bot",
      githubUsername: "malformed[bot]",
      credentials: {},
    };
    const patchSecretRefs = vi.fn();
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    Object.assign(harness.ctx.config, {
      get: vi.fn(async () => ({ identities: { "agent-github": malformedGitHubConfig } })),
      patchSecretRefs,
    });
    harness.seed({
      agents: [{ id: "agent-github", companyId: "company_1", name: "Malformed GitHub Bot" } as never],
    });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-github" },
      { companyId: "company_1" },
    );

    expect(patchSecretRefs).not.toHaveBeenCalled();
  });

  it("restores the exact Slack company config when the settings-state deletion fails", async () => {
    const previousSlackConfig = {
      label: "Rollback Slack Bot",
      teamId: "T12345678",
      appId: "A12345678",
      botUserId: "U12345678",
      defaultChannel: "C12345678",
      credentials: {
        botToken: { type: "secret_ref", secretId: TEST_SECRET_ID, version: "latest" },
        signingSecret: { type: "secret_ref", secretId: TEST_SECRET_ID_2, version: "latest" },
      },
    };
    let companyConfig: Record<string, unknown> = {
      identities: {
        "agent-rollback-slack": {
          label: "Rollback GitHub Bot",
          githubUsername: "rollback-github[bot]",
          slack: structuredClone(previousSlackConfig),
        },
      },
    };
    const patchSecretRefs = vi.fn(async (input: {
      companyId?: string;
      path: string[];
      value: Record<string, unknown> | null;
    }) => {
      const agentId = input.path[1];
      if (
        input.companyId !== "company_1" ||
        input.path[0] !== "identities" ||
        !agentId ||
        input.path[2] !== "slack"
      ) {
        throw new Error("Unexpected company config patch.");
      }
      const identities = {
        ...(companyConfig.identities as Record<string, unknown>),
      };
      const identity = { ...(identities[agentId] as Record<string, unknown>) };
      if (input.value === null) delete identity.slack;
      else identity.slack = structuredClone(input.value);
      identities[agentId] = identity;
      companyConfig = { ...companyConfig, identities };
    });
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    Object.assign(harness.ctx.config, {
      get: vi.fn(async (companyId?: string) => companyId === "company_1" ? structuredClone(companyConfig) : {}),
      patchSecretRefs,
    });
    harness.seed({
      agents: [
        { id: "agent-rollback-slack", companyId: "company_1", name: "Rollback Slack Bot" } as never,
      ],
    });
    await plugin.definition.setup(harness.ctx);
    const previousSettingsState = {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-rollback-slack:slack": {
          provider: "slack",
          id: "agent-rollback-slack:slack",
          agentId: "agent-rollback-slack",
          label: "Rollback Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
      },
    };
    await harness.ctx.state.set(CONFIG_SCOPE, previousSettingsState);

    const originalStateSet = harness.ctx.state.set.bind(harness.ctx.state);
    let failNextSettingsWrite = true;
    vi.spyOn(harness.ctx.state, "set").mockImplementation(async (scope, value) => {
      if (scope === CONFIG_SCOPE && failNextSettingsWrite) {
        failNextSettingsWrite = false;
        throw new Error("settings state unavailable");
      }
      await originalStateSet(scope, value);
    });

    await expect(harness.performAction(
      "delete-bot-identity-config",
      { provider: "slack", agentId: "agent-rollback-slack" },
      { companyId: "company_1" },
    )).rejects.toThrow("settings state unavailable");

    expect(harness.getState(CONFIG_SCOPE)).toEqual(previousSettingsState);
    expect(companyConfig).toEqual({
      identities: {
        "agent-rollback-slack": {
          label: "Rollback GitHub Bot",
          githubUsername: "rollback-github[bot]",
          slack: previousSlackConfig,
        },
      },
    });
    expect(patchSecretRefs).toHaveBeenCalledTimes(2);
    expect(patchSecretRefs).toHaveBeenNthCalledWith(1, {
      companyId: "company_1",
      path: ["identities", "agent-rollback-slack", "slack"],
      value: null,
    });
    expect(patchSecretRefs).toHaveBeenNthCalledWith(2, {
      companyId: "company_1",
      path: ["identities", "agent-rollback-slack", "slack"],
      value: previousSlackConfig,
    });
  });

  it("surfaces both deletion and Slack-subtree rollback failures without changing GitHub config", async () => {
    const previousSlackConfig = {
      label: "Rollback Slack Bot",
      teamId: "T12345678",
      appId: "A12345678",
      botUserId: "U12345678",
      credentials: {
        botToken: { type: "secret_ref", secretId: TEST_SECRET_ID, version: "latest" },
        signingSecret: { type: "secret_ref", secretId: TEST_SECRET_ID_2, version: "latest" },
      },
    };
    const githubConfig = {
      label: "Rollback GitHub Bot",
      githubUsername: "rollback-github[bot]",
    };
    let companyConfig: Record<string, unknown> = {
      identities: {
        "agent-rollback-slack": { ...githubConfig, slack: previousSlackConfig },
      },
    };
    const patchSecretRefs = vi.fn(async (input: {
      companyId?: string;
      path: string[];
      value: Record<string, unknown> | null;
    }) => {
      if (input.value !== null) throw new Error("Slack rollback failed");
      companyConfig = {
        identities: { "agent-rollback-slack": githubConfig },
      };
    });
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    Object.assign(harness.ctx.config, {
      get: vi.fn(async () => structuredClone(companyConfig)),
      patchSecretRefs,
    });
    harness.seed({
      agents: [{ id: "agent-rollback-slack", companyId: "company_1", name: "Rollback Slack Bot" } as never],
    });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "agent-rollback-slack:slack": {
          provider: "slack",
          id: "agent-rollback-slack:slack",
          agentId: "agent-rollback-slack",
          label: "Rollback Slack Bot",
          slack: { teamId: "T12345678", appId: "A12345678", botUserId: "U12345678" },
        },
      },
    });
    vi.spyOn(harness.ctx.state, "set").mockRejectedValueOnce(new Error("settings state unavailable"));

    let failure: unknown;
    try {
      await harness.performAction(
        "delete-bot-identity-config",
        { provider: "slack", agentId: "agent-rollback-slack" },
        { companyId: "company_1" },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      "settings state unavailable",
      "Slack rollback failed",
    ]);
    expect(companyConfig).toEqual({
      identities: { "agent-rollback-slack": githubConfig },
    });
    expect(patchSecretRefs).toHaveBeenNthCalledWith(2, {
      companyId: "company_1",
      path: ["identities", "agent-rollback-slack", "slack"],
      value: previousSlackConfig,
    });
  });

  it("uses provider settings-page state for agent tools", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);
    await harness.ctx.state.set(CONFIG_SCOPE, {
      version: 5,
      cleanupTombstones: {},
      identities: {
        "settings-agent:github": {
          provider: "github", id: "settings-agent:github", agentId: "settings-agent",
          label: "Settings Bot", github: { username: "paperclip-settings-bot" },
        },
      },
    });

    const whoami = await harness.executeTool<{ data?: Record<string, unknown>; error?: string }>(
      "github_bot_whoami",
      {},
      { agentId: "settings-agent" }
    );

    expect(whoami.error).toBeUndefined();
    expect(whoami.data).toEqual(expect.objectContaining({
      label: "Settings Bot",
      githubUsername: "paperclip-settings-bot",
    }));
  });

  it("uses settings-page state for agent tools when instance config is empty", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-from-settings",
      label: "Settings Bot",
      github: { username: "paperclip-settings-bot" },
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
    }));
  });

  it("rejects save when required fields are missing", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    await expect(
      harness.performAction("save-bot-identity-config", {
        agentId: "",
        label: "Test",
        github: { username: "bot" },
      })
    ).rejects.toThrow("Required fields");
  });

  it("stores optional commit identity fields", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-1",
      label: "Deploy Bot",
      github: { username: "paperclip-deploy", commitName: "Paperclip Deploy", commitEmail: "deploy@paperclip.ai" },
    });

    expect(saved.provider === "github" && saved.github.commitName).toBe("Paperclip Deploy");
    expect(saved.provider === "github" && saved.github.commitEmail).toBe("deploy@paperclip.ai");
  });

  it("saves v4 nested provider state and keeps credentials sidecar-only", async () => {
    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities, "events.emit"] });
    await plugin.definition.setup(harness.ctx);

    const saved = await harness.performAction<BotIdentityConfig>("save-bot-identity-config", {
      provider: "github",
      agentId: "agent-v4",
      label: "V4 Bot",
      github: {
        username: "v4-bot",
        commitName: "V4 Bot",
        commitEmail: "v4@example.com",
        app: { credentialPropagationAgentIds: ["agent-reviewer"] },
      },
      credential: { secretId: TEST_SECRET_ID },
    });

    expect(saved.provider).toBe("github");
    expect(saved.provider === "github" && saved.github.username).toBe("v4-bot");

    const rawState = await harness.ctx.state.get(CONFIG_SCOPE) as { version: number; identities: Record<string, unknown> };
    expect(rawState.version).toBe(5);
    expect(rawState.identities["agent-v4:github"]).toMatchObject({
      provider: "github",
      github: { username: "v4-bot", commitName: "V4 Bot", commitEmail: "v4@example.com" },
    });

    const sidecar = JSON.parse(await readFile(process.env[CREDENTIAL_SIDECAR_PATH_ENV]!, "utf8"));
    expect(sidecar.identities["agent-v4:github"]).toEqual({ secretId: TEST_SECRET_ID });
  });
});

describe("settings credential paths", () => {
  it("preserves a root-level sidecar directory", () => {
    expect(getGitHubAppPrivateKeyFile("/credentials.json", "agent-manifest"))
      .toBe("/github-apps/agent-manifest/private-key.pem");
  });
});
