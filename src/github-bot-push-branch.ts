import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { normalizeGitHubRepoRef } from "./identity-policy.js";
import { resolveAgentIdentityFromPluginSettings } from "./config-source.js";
import { resolveIdentityToken } from "./credential-sidecar.js";

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

type PushBranchOutcomeLogInput = {
  message: string;
  outcome: string;
  branch: string;
  remote: string;
  repository?: string;
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

function validateRemoteName(remote: string): string | null {
  const trimmed = remote.trim();
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

async function logPushBranchOutcome(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  input: PushBranchOutcomeLogInput
): Promise<void> {
  const metadata: Record<string, unknown> = {
    agentId: runCtx.agentId,
    runId: runCtx.runId,
    branch: input.branch,
    remote: input.remote,
    outcome: input.outcome
  };

  if (input.repository) {
    metadata.repository = input.repository;
  }
  if (input.expectedRepository) {
    metadata.expectedRepository = input.expectedRepository;
  }
  if (input.dryRun !== undefined) {
    metadata.dryRun = input.dryRun;
  }

  await ctx.activity.log({
    companyId: runCtx.companyId,
    entityType: "run",
    entityId: runCtx.runId,
    message: input.message,
    metadata
  });
}

export function createGithubBotPushBranchTool(ctx: PluginContext) {
  return async (paramsInput: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
    const params = parseToolParams(paramsInput);
    if (!params) {
      return { error: "Invalid parameters. Expected { branch, remote?, expectedRepository?, dryRun? }." };
    }

    const branch = validateBranchName(params.branch);
    if (!branch) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: invalid branch name",
        outcome: "invalid_branch",
        branch: params.branch,
        remote: params.remote ?? "origin"
      });
      return { error: "Invalid branch. Use a non-empty branch name without whitespace." };
    }

    const remote = validateRemoteName(params.remote ?? "origin");
    if (!remote) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: invalid remote name",
        outcome: "invalid_remote",
        branch,
        remote: params.remote ?? ""
      });
      return { error: "Invalid remote. Use a non-empty remote name without whitespace." };
    }
    const expectedRepository = params.expectedRepository?.trim();
    const dryRun = params.dryRun === true;

    const workspace = await ctx.projects.getPrimaryWorkspace(runCtx.projectId, runCtx.companyId);
    if (!workspace?.path) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: missing project workspace",
        outcome: "missing_workspace",
        branch,
        remote
      });
      return { error: "No primary workspace is configured for this project." };
    }

    const remoteResolution = await runGitCommand({
      args: ["remote", "get-url", remote],
      cwd: workspace.path
    });

    if (remoteResolution.exitCode !== 0) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: remote resolution",
        outcome: "remote_resolution_failed",
        branch,
        remote
      });
      return { error: `Unable to resolve git remote '${remote}'.` };
    }

    const repository = normalizeGitHubRepoRef(remoteResolution.stdout);
    if (!repository) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch denied: unsupported remote",
        outcome: "denied_remote_url",
        branch,
        remote
      });
      return { error: "Push denied: remote must be a GitHub repository URL." };
    }

    let resolvedIdentity: Awaited<ReturnType<typeof resolveAgentIdentityFromPluginSettings>>;
    try {
      resolvedIdentity = await resolveAgentIdentityFromPluginSettings(ctx, runCtx);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: missing config",
        outcome: "missing_config",
        repository: repository.fullName,
        branch,
        remote
      });
      return { error: reason };
    }

    if (expectedRepository) {
      const normalizedExpected = normalizeExpectedRepository(expectedRepository);
      if (!normalizedExpected) {
        await logPushBranchOutcome(ctx, runCtx, {
          message: "github_bot_push_branch failed: invalid expectedRepository",
          outcome: "invalid_expected_repository",
          repository: repository.fullName,
          branch,
          remote
        });
        return { error: "Invalid expectedRepository format. Use 'owner/repo' or a GitHub URL." };
      }
      if (normalizedExpected !== repository.fullName) {
        await logPushBranchOutcome(ctx, runCtx, {
          message: "github_bot_push_branch denied: expectedRepository mismatch",
          outcome: "denied_expected_repository_mismatch",
          repository: repository.fullName,
          expectedRepository: normalizedExpected,
          branch,
          remote
        });
        return { error: `Push denied: repository mismatch. Expected '${normalizedExpected}', found '${repository.fullName}'.` };
      }
    }

    let token: string;
    try {
      ({ token } = await resolveIdentityToken(resolvedIdentity, ctx.secrets.resolve.bind(ctx.secrets), ctx.http.fetch.bind(ctx.http)));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: credential resolution",
        outcome: "credential_resolution_failed",
        repository: repository.fullName,
        branch,
        remote
      });
      return { error: reason || "Failed to resolve agent identity authentication credentials." };
    }
    let authEnv: Awaited<ReturnType<typeof buildGitAuthEnvironment>>;

    try {
      authEnv = await buildGitAuthEnvironment(token);
    } catch (error) {
      const message = redactSecretText(error instanceof Error ? error.message : String(error), [token]);
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: execution exception",
        outcome: "auth_setup_exception",
        repository: repository.fullName,
        branch,
        remote
      });
      return { error: `git auth setup failed: ${message}` };
    }

    try {
      const pushArgs = ["-c", "credential.helper=", "push"];
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
        await logPushBranchOutcome(ctx, runCtx, {
          message: "github_bot_push_branch failed: git push",
          outcome: "push_failed",
          repository: repository.fullName,
          branch,
          remote
        });
        return {
          error: `git push failed for '${repository.fullName}' branch '${branch}'.`,
          data: {
            stdout: redactedStdout,
            stderr: redactedStderr
          }
        };
      }

      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch succeeded",
        outcome: "success",
        repository: repository.fullName,
        branch,
        remote,
        dryRun
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
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: execution exception",
        outcome: "push_exception",
        repository: repository.fullName,
        branch,
        remote
      });
      return { error: `git push failed: ${message}` };
    } finally {
      await authEnv.cleanup();
    }
  };
}
