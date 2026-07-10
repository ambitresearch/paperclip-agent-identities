import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ResourceReference } from "../../../core/resource-reference.js";
import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import { normalizeGitHubRepoRef } from "../repo-ref.js";
import {
  GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  githubBotPushBranchToolDefinition
} from "../../../shared/github-bot-push-branch-tool-definition.js";

export interface GitHubPushTarget extends ResourceReference {
  readonly kind: "github-push-target";
  readonly owner: string;
  readonly repo: string;
  readonly fullName: string;
  readonly workspacePath: string;
  readonly remoteName: string;
  readonly branch: string;
  readonly dryRun: boolean;
}

// ---- helpers moved verbatim from src/github-bot-push-branch.ts:10-221 ----

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

// ---- tool spec ----

function validateParams(raw: unknown): ParamsValidation {
  const parsed = parseToolParams(raw);
  if (!parsed) {
    return { ok: false, error: "Invalid parameters. Expected { branch, remote?, expectedRepository?, dryRun? }." };
  }
  return { ok: true, params: parsed };
}

export const githubPushBranchToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubPushTarget> = {
  name: GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  metadata: githubBotPushBranchToolDefinition,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubPushTarget>> {
    const { ctx, runCtx } = input;
    const params = input.params as GithubBotPushBranchParams;

    const branch = validateBranchName(params.branch);
    if (!branch) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: invalid branch name",
        outcome: "invalid_branch",
        branch: params.branch,
        remote: params.remote ?? "origin"
      });
      return { ok: false, error: "Invalid branch. Use a non-empty branch name without whitespace." };
    }

    const remote = validateRemoteName(params.remote ?? "origin");
    if (!remote) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: invalid remote name",
        outcome: "invalid_remote",
        branch,
        remote: params.remote ?? ""
      });
      return { ok: false, error: "Invalid remote. Use a non-empty remote name without whitespace." };
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
      return { ok: false, error: "No primary workspace is configured for this project." };
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
      return { ok: false, error: `Unable to resolve git remote '${remote}'.` };
    }

    const repository = normalizeGitHubRepoRef(remoteResolution.stdout);
    if (!repository) {
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch denied: unsupported remote",
        outcome: "denied_remote_url",
        branch,
        remote
      });
      return { ok: false, error: "Push denied: remote must be a GitHub repository URL." };
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
        return { ok: false, error: "Invalid expectedRepository format. Use 'owner/repo' or a GitHub URL." };
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
        return {
          ok: false,
          error: `Push denied: repository mismatch. Expected '${normalizedExpected}', found '${repository.fullName}'.`
        };
      }
    }

    return {
      ok: true,
      ref: {
        kind: "github-push-target",
        owner: repository.owner,
        repo: repository.repo,
        fullName: repository.fullName,
        workspacePath: workspace.path,
        remoteName: remote,
        branch,
        dryRun
      }
    };
  },
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, GitHubPushTarget>
  ): Promise<unknown> {
    const ctx = execution.ctx;
    const runCtx = execution.runCtx;
    const target = execution.resourceRef;
    if (target === null) {
      return { error: "Internal error: missing resolved push target." };
    }
    if (execution.token === null) {
      return { error: "Internal error: missing resolved credential." };
    }
    const token = execution.token;
    const { fullName, workspacePath, remoteName, branch, dryRun } = target;

    let authEnv: Awaited<ReturnType<typeof buildGitAuthEnvironment>>;

    try {
      authEnv = await buildGitAuthEnvironment(token);
    } catch (error) {
      const message = redactSecretText(error instanceof Error ? error.message : String(error), [token]);
      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch failed: execution exception",
        outcome: "auth_setup_exception",
        repository: fullName,
        branch,
        remote: remoteName
      });
      return { error: `git auth setup failed: ${message}` };
    }

    try {
      const pushArgs = ["-c", "credential.helper=", "push"];
      if (dryRun) {
        pushArgs.push("--dry-run");
      }
      pushArgs.push(`https://github.com/${fullName}.git`);
      pushArgs.push(`HEAD:${toBranchRef(branch)}`);

      const pushResult = await runGitCommand({
        args: pushArgs,
        cwd: workspacePath,
        env: authEnv.env
      });

      const redactedStdout = redactSecretText(pushResult.stdout, [token]);
      const redactedStderr = redactSecretText(pushResult.stderr, [token]);

      if (pushResult.exitCode !== 0) {
        await logPushBranchOutcome(ctx, runCtx, {
          message: "github_bot_push_branch failed: git push",
          outcome: "push_failed",
          repository: fullName,
          branch,
          remote: remoteName
        });
        return {
          error: `git push failed for '${fullName}' branch '${branch}'.`,
          data: {
            stdout: redactedStdout,
            stderr: redactedStderr
          }
        };
      }

      await logPushBranchOutcome(ctx, runCtx, {
        message: "github_bot_push_branch succeeded",
        outcome: "success",
        repository: fullName,
        branch,
        remote: remoteName,
        dryRun
      });

      return {
        content: dryRun
          ? `Dry-run push succeeded for ${fullName}:${branch}.`
          : `Push succeeded for ${fullName}:${branch}.`,
        data: {
          repository: fullName,
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
        repository: fullName,
        branch,
        remote: remoteName
      });
      return { error: `git push failed: ${message}` };
    } finally {
      await authEnv.cleanup();
    }
  }
};
