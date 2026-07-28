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

type BuildCtxOptions = {
  issues?: Array<Record<string, unknown>>;
  executionWorkspace?: Record<string, unknown> | null;
  primaryWorkspace?: { path: string } | null;
};

function buildCtx(options: BuildCtxOptions = {}) {
  return {
    projects: {
      getPrimaryWorkspace: vi.fn(async () => options.primaryWorkspace === undefined
        ? { path: "/work/repo" }
        : options.primaryWorkspace)
    },
    issues: { list: vi.fn(async () => options.issues ?? []) },
    executionWorkspaces: {
      get: vi.fn(async () => options.executionWorkspace ?? null)
    },
    activity: { log: vi.fn(async () => {}) },
    logger: { info: vi.fn(), error: vi.fn() }
  };
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
      ctx: buildCtx() as never,
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

  it("uses the matching execution run workspace cwd without reading the primary workspace", async () => {
    const ctx = buildCtx({
      issues: [{
        executionRunId: "r-1",
        checkoutRunId: null,
        executionWorkspaceId: "execution-workspace-1"
      }],
      executionWorkspace: {
        cwd: "/work/execution-cwd",
        path: "/work/execution-path"
      }
    });
    const gitCommands: Array<{ args: string[]; cwd: string }> = [];
    __setGitCommandRunnerForTests(async ({ args, cwd }) => {
      gitCommands.push({ args, cwd });
      return {
        exitCode: 0,
        stdout: "https://github.com/acme/widgets.git\n",
        stderr: ""
      };
    });

    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x" },
      identity,
      ctx: ctx as never,
      runCtx
    });

    expect(ctx.issues.list).toHaveBeenCalledWith({
      companyId: "co-1",
      projectId: "p-1",
      assigneeAgentId: "agent-1",
      status: "in_progress"
    });
    expect(ctx.executionWorkspaces.get).toHaveBeenCalledWith("execution-workspace-1", "co-1");
    expect(ctx.projects.getPrimaryWorkspace).not.toHaveBeenCalled();
    expect(gitCommands).toEqual([{
      args: ["remote", "get-url", "origin"],
      cwd: "/work/execution-cwd"
    }]);
    expect(res).toEqual(expect.objectContaining({
      ok: true,
      ref: expect.objectContaining({ workspacePath: "/work/execution-cwd" })
    }));
  });

  it("uses the matching execution workspace when the tool run project id is blank", async () => {
    const ctx = buildCtx({
      issues: [{
        executionRunId: "r-1",
        checkoutRunId: null,
        executionWorkspaceId: "execution-workspace-1"
      }],
      executionWorkspace: { cwd: "/work/execution-cwd" }
    });
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: "https://github.com/acme/widgets.git\n",
      stderr: ""
    }));

    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x" },
      identity,
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "", runId: "r-1" } as never
    });

    expect(ctx.issues.list).toHaveBeenCalledWith({
      companyId: "co-1",
      assigneeAgentId: "agent-1",
      status: "in_progress"
    });
    expect(ctx.executionWorkspaces.get).toHaveBeenCalledWith("execution-workspace-1", "co-1");
    expect(ctx.projects.getPrimaryWorkspace).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({
      ok: true,
      ref: expect.objectContaining({ workspacePath: "/work/execution-cwd" })
    }));
  });

  it("uses an execution workspace path matched through checkoutRunId", async () => {
    const ctx = buildCtx({
      issues: [{
        executionRunId: null,
        checkoutRunId: "r-1",
        executionWorkspaceId: "execution-workspace-2"
      }],
      executionWorkspace: {
        cwd: null,
        path: "/work/checkout"
      }
    });
    __setGitCommandRunnerForTests(async ({ cwd }) => ({
      exitCode: 0,
      stdout: cwd === "/work/checkout" ? "https://github.com/acme/widgets.git\n" : "",
      stderr: ""
    }));

    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x" },
      identity,
      ctx: ctx as never,
      runCtx
    });

    expect(ctx.executionWorkspaces.get).toHaveBeenCalledWith("execution-workspace-2", "co-1");
    expect(ctx.projects.getPrimaryWorkspace).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({
      ok: true,
      ref: expect.objectContaining({ workspacePath: "/work/checkout" })
    }));
  });

  it.each([
    ["missing", null],
    ["unusable", { cwd: " ", path: "" }]
  ])("falls back to the primary workspace when the execution workspace is %s", async (_label, executionWorkspace) => {
    const ctx = buildCtx({
      issues: [{
        executionRunId: "r-1",
        checkoutRunId: null,
        executionWorkspaceId: "execution-workspace-1"
      }],
      executionWorkspace
    });
    const gitCwds: string[] = [];
    __setGitCommandRunnerForTests(async ({ cwd }) => {
      gitCwds.push(cwd);
      return {
        exitCode: 0,
        stdout: "https://github.com/acme/widgets.git\n",
        stderr: ""
      };
    });

    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x" },
      identity,
      ctx: ctx as never,
      runCtx
    });

    expect(ctx.executionWorkspaces.get).toHaveBeenCalledWith("execution-workspace-1", "co-1");
    expect(ctx.projects.getPrimaryWorkspace).toHaveBeenCalledWith("p-1", "co-1");
    expect(gitCwds).toEqual(["/work/repo"]);
    expect(res).toEqual(expect.objectContaining({
      ok: true,
      ref: expect.objectContaining({ workspacePath: "/work/repo" })
    }));
  });

  it("fails closed without querying a primary workspace when the tool run project id is blank", async () => {
    const ctx = buildCtx();

    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x" },
      identity,
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "", runId: "r-1" } as never
    });

    expect(ctx.issues.list).toHaveBeenCalledWith({
      companyId: "co-1",
      assigneeAgentId: "agent-1",
      status: "in_progress"
    });
    expect(ctx.projects.getPrimaryWorkspace).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, error: "No primary workspace is configured for this project." });
  });

  it("fails closed on an invalid branch name", async () => {
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "-bad branch" },
      identity,
      ctx: buildCtx() as never,
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
      ctx: buildCtx() as never,
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
      ctx: buildCtx() as never,
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
      ctx: buildCtx() as never,
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
