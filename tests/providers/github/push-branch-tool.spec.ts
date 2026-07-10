import { describe, it, expect, vi, afterEach } from "vitest";
import {
  githubPushBranchToolSpec,
  __setGitCommandRunnerForTests,
  __resetGitCommandRunnerForTests
} from "../../../src/providers/github/tools/push-branch.js";
import type { GitHubPushTarget } from "../../../src/providers/github/tools/push-branch.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

const runCtx = { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never;

function buildCtx() {
  return {
    projects: { getPrimaryWorkspace: vi.fn(async () => ({ path: "/work/repo" })) },
    activity: { log: vi.fn(async () => {}) },
    logger: { info: vi.fn(), error: vi.fn() }
  } as never;
}

afterEach(() => {
  __resetGitCommandRunnerForTests();
});

describe("githubPushBranchToolSpec.validateParams", () => {
  it("rejects params without a branch", () => {
    expect(githubPushBranchToolSpec.validateParams({})).toEqual({
      ok: false,
      error: "Invalid parameters. Expected { branch, remote?, expectedRepository?, dryRun? }."
    });
  });

  it("accepts a minimal valid param set", () => {
    const res = githubPushBranchToolSpec.validateParams({ branch: "feature/x" });
    expect(res.ok).toBe(true);
  });
});

describe("githubPushBranchToolSpec.resolveResourceRef", () => {
  it("resolves a github-push-target from a GitHub remote", async () => {
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: "https://github.com/acme/widgets.git\n",
      stderr: ""
    }));
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x" },
      identity,
      ctx: buildCtx(),
      runCtx
    });
    expect(res).toEqual({
      ok: true,
      ref: {
        kind: "github-push-target",
        owner: "acme",
        repo: "widgets",
        fullName: "acme/widgets",
        workspacePath: "/work/repo",
        remoteName: "origin",
        branch: "feature/x",
        dryRun: false
      }
    });
  });

  it("fails closed on an invalid branch name", async () => {
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "-bad branch" },
      identity,
      ctx: buildCtx(),
      runCtx
    });
    expect(res).toEqual({ ok: false, error: "Invalid branch. Use a non-empty branch name without whitespace." });
  });

  it("denies a non-GitHub remote", async () => {
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: "https://gitlab.com/acme/widgets.git\n",
      stderr: ""
    }));
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x" },
      identity,
      ctx: buildCtx(),
      runCtx
    });
    expect(res).toEqual({ ok: false, error: "Push denied: remote must be a GitHub repository URL." });
  });

  it("denies an expectedRepository mismatch", async () => {
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: "https://github.com/acme/widgets.git\n",
      stderr: ""
    }));
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x", expectedRepository: "acme/other" },
      identity,
      ctx: buildCtx(),
      runCtx
    });
    expect(res).toEqual({
      ok: false,
      error: "Push denied: repository mismatch. Expected 'acme/other', found 'acme/widgets'."
    });
  });
});

describe("githubPushBranchToolSpec.perform", () => {
  function target(): GitHubPushTarget {
    return {
      kind: "github-push-target",
      owner: "acme",
      repo: "widgets",
      fullName: "acme/widgets",
      workspacePath: "/work/repo",
      remoteName: "origin",
      branch: "feature/x",
      dryRun: false
    };
  }

  function execution(
    token: string | null,
    ref: GitHubPushTarget | null
  ): ProviderToolExecution<GitHubAgentIdentity, GitHubPushTarget> {
    return {
      token,
      identity,
      resourceRef: ref,
      params: { branch: "feature/x" },
      ctx: buildCtx(),
      runCtx
    };
  }

  it("fails closed when the resolved push target is null", async () => {
    const result = (await githubPushBranchToolSpec.perform(execution("tok", null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved push target.");
  });

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubPushBranchToolSpec.perform(execution(null, target()))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("pushes and returns a success payload", async () => {
    __setGitCommandRunnerForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const result = (await githubPushBranchToolSpec.perform(execution("tok", target()))) as {
      content: string;
      data: { repository: string };
    };
    expect(result.content).toContain("Push succeeded for acme/widgets:feature/x.");
    expect(result.data.repository).toBe("acme/widgets");
  });
});
