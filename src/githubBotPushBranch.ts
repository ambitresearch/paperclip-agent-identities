import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { evaluateRepoPolicy, normalizeGitHubRepoRef, resolveAgentIdentityFromToolRunContext } from "./identity-policy.js";

type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type GitCommandRunnerInput = {
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

type GitCommandRunner = (input: GitCommandRunnerInput) => Promise<GitCommandResult>;


type GithubBotPushBranchParams = {
  branch: string;
  remote?: string;
  expectedRepository?: string;
  dryRun?: boolean;
};

const runGitCommandDefault: GitCommandRunner = async ({ args, cwd, env }) => {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr
      });
    });
  });
};

let runGitCommand: GitCommandRunner = runGitCommandDefault;

export function __setGitCommandRunnerForTests(runner: GitCommandRunner): void {
  runGitCommand = runner;
}

export function __resetGitCommandRunnerForTests(): void {
  runGitCommand = runGitCommandDefault;
}

function redactSecretText(input: string, secretValues: string[]): string {
  let output = input;
  for (const secretValue of secretValues) {
    if (!secretValue) {
      continue;
    }
    const encoded = encodeURIComponent(secretValue);
    const basicAuth = Buffer.from(`x-access-token:${secretValue}`, "utf8").toString("base64");
    for (const token of [secretValue, encoded, basicAuth]) {
      output = output.split(token).join("[REDACTED]");
    }
  }
  return output;
}

function normalizeExpectedRepository(input: string): string | null {
  return normalizeGitHubRepoRef(input)?.fullName ?? null;
}

function validateBranchName(branch: string): string | null {
  const trimmed = branch.trim();
  if (!trimmed) {
    return null;
  }
  if (/[\s\0]/.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("-")) {
    return null;
  }
  return trimmed;
}

function toBranchRef(branch: string): string {
  return branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
}

async function buildGitAuthEnvironment(token: string): Promise<{ env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "paperclip-github-bot-push-"));
  const askPassPath = join(tempDir, "askpass.sh");
  const script = `#!/bin/sh
case "$1" in
  *Username*) printf "%s" "x-access-token" ;;
  *Password*) printf "%s" "$GITHUB_TOKEN" ;;
  *) printf "%s" "" ;;
esac
`;

  try {
    await writeFile(askPassPath, script, { encoding: "utf8", mode: 0o700 });
    await chmod(askPassPath, 0o700);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    env: {
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: askPassPath,
      GITHUB_TOKEN: token
    },
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    }
  };
}

function parseToolParams(input: unknown): GithubBotPushBranchParams | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Record<string, unknown>;
  if (typeof candidate.branch !== "string") {
    return null;
  }
  if (candidate.remote !== undefined && typeof candidate.remote !== "string") {
    return null;
  }
  if (candidate.expectedRepository !== undefined && typeof candidate.expectedRepository !== "string") {
    return null;
  }
  if (candidate.dryRun !== undefined && typeof candidate.dryRun !== "boolean") {
    return null;
  }
  return {
    branch: candidate.branch,
    remote: candidate.remote,
    expectedRepository: candidate.expectedRepository,
    dryRun: candidate.dryRun
  };
}

export function createGithubBotPushBranchTool(ctx: PluginContext) {
  return async (paramsInput: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
    const params = parseToolParams(paramsInput);
    if (!params) {
      return { error: "Invalid parameters. Expected { branch, remote?, expectedRepository?, dryRun? }." };
    }

    const branch = validateBranchName(params.branch);
    if (!branch) {
      return { error: "Invalid branch. Use a non-empty branch name without whitespace." };
    }

    const remote = (params.remote ?? "origin").trim();
    const expectedRepository = params.expectedRepository?.trim();
    const dryRun = params.dryRun === true;

    const workspace = await ctx.projects.getPrimaryWorkspace(runCtx.projectId, runCtx.companyId);
    if (!workspace?.path) {
      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "github_bot_push_branch failed: missing project workspace",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          branch,
          remote,
          outcome: "missing_workspace"
        }
      });
      return { error: "No primary workspace is configured for this project." };
    }

    const remoteResolution = await runGitCommand({
      args: ["remote", "get-url", remote],
      cwd: workspace.path
    });

    if (remoteResolution.exitCode !== 0) {
      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "github_bot_push_branch failed: remote resolution",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          branch,
          remote,
          outcome: "remote_resolution_failed"
        }
      });
      return { error: `Unable to resolve git remote '${remote}'.` };
    }

    const repository = normalizeGitHubRepoRef(remoteResolution.stdout);
    if (!repository) {
      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "github_bot_push_branch denied: unsupported remote",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          branch,
          remote,
          outcome: "denied_remote_url"
        }
      });
      return { error: "Push denied: remote must be a GitHub repository URL." };
    }

    const config = await ctx.config.get();

    let resolvedIdentity: ReturnType<typeof resolveAgentIdentityFromToolRunContext>;
    try {
      resolvedIdentity = resolveAgentIdentityFromToolRunContext(config, runCtx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "github_bot_push_branch failed: missing config",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          repository: repository.fullName,
          branch,
          remote,
          outcome: "missing_config"
        }
      });
      return { error: reason };
    }

    const policyDecision = evaluateRepoPolicy(resolvedIdentity.identity, repository.fullName);
    if (!policyDecision.allowed) {
      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "github_bot_push_branch denied: owner policy",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          repository: repository.fullName,
          branch,
          remote,
          outcome: "denied_owner_policy"
        }
      });
      return { error: `Push denied for '${repository.fullName}': ${policyDecision.reason}.` };
    }

    if (expectedRepository) {
      const normalizedExpected = normalizeExpectedRepository(expectedRepository);
      if (!normalizedExpected) {
        await ctx.activity.log({
          companyId: runCtx.companyId,
          entityType: "run",
          entityId: runCtx.runId,
          message: "github_bot_push_branch failed: invalid expectedRepository",
          metadata: {
            agentId: runCtx.agentId,
            runId: runCtx.runId,
            repository: repository.fullName,
            branch,
            remote,
            outcome: "invalid_expected_repository"
          }
        });
        return { error: "Invalid expectedRepository format. Use 'owner/repo' or a GitHub URL." };
      }
      if (normalizedExpected !== repository.fullName) {
        await ctx.activity.log({
          companyId: runCtx.companyId,
          entityType: "run",
          entityId: runCtx.runId,
          message: "github_bot_push_branch denied: expectedRepository mismatch",
          metadata: {
            agentId: runCtx.agentId,
            runId: runCtx.runId,
            repository: repository.fullName,
            expectedRepository: normalizedExpected,
            branch,
            remote,
            outcome: "denied_expected_repository_mismatch"
          }
        });
        return { error: `Push denied: repository mismatch. Expected '${normalizedExpected}', found '${repository.fullName}'.` };
      }
    }

    const token = await ctx.secrets.resolve(resolvedIdentity.identity.tokenSecretRef);

    let authEnv: Awaited<ReturnType<typeof buildGitAuthEnvironment>> | null = null;

    try {
      authEnv = await buildGitAuthEnvironment(token);
      const pushArgs = ["push"];
      if (dryRun) {
        pushArgs.push("--dry-run");
      }
      pushArgs.push(`https://github.com/${repository.fullName}.git`);
      pushArgs.push(`HEAD:${toBranchRef(branch)}`);

      const pushResult = await runGitCommand({
        args: pushArgs,
        cwd: workspace.path,
        env: authEnv.env
      });

      const redactedStdout = redactSecretText(pushResult.stdout, [token]);
      const redactedStderr = redactSecretText(pushResult.stderr, [token]);

      if (pushResult.exitCode !== 0) {
        await ctx.activity.log({
          companyId: runCtx.companyId,
          entityType: "run",
          entityId: runCtx.runId,
          message: "github_bot_push_branch failed: git push",
          metadata: {
            agentId: runCtx.agentId,
            runId: runCtx.runId,
            repository: repository.fullName,
            branch,
            remote,
            outcome: "push_failed"
          }
        });
        return {
          error: `git push failed for '${repository.fullName}' branch '${branch}'.`,
          data: {
            stdout: redactedStdout,
            stderr: redactedStderr
          }
        };
      }

      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "github_bot_push_branch succeeded",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          repository: repository.fullName,
          branch,
          remote,
          dryRun,
          outcome: "success"
        }
      });

      return {
        content: dryRun
          ? `Dry-run push succeeded for ${repository.fullName}:${branch}.`
          : `Push succeeded for ${repository.fullName}:${branch}.`,
        data: {
          repository: repository.fullName,
          branch,
          dryRun,
          stdout: redactedStdout,
          stderr: redactedStderr
        }
      };
    } catch (error) {
      const message = redactSecretText(error instanceof Error ? error.message : String(error), [token]);
      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "github_bot_push_branch failed: execution exception",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          repository: repository.fullName,
          branch,
          remote,
          outcome: "push_exception"
        }
      });
      return { error: `git push failed: ${message}` };
    } finally {
      if (authEnv) {
        await authEnv.cleanup();
      }
    }
  };
}
