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
    issues: { list: vi.fn(async (_input?: Record<string, unknown>) => options.issues ?? []) },
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
      error: "Invalid parameters. Expected { branch, remote?, expectedRepository?, dryRun?, expectedCurrentSha? }."
    });
  });

  it("accepts a minimal valid param set", () => {
    const res = githubPushBranchToolSpec.validateParams({ branch: "feature/x" });
    expect(res.ok).toBe(true);
  });

  it("rejects a non-string expectedCurrentSha", () => {
    const res = githubPushBranchToolSpec.validateParams({ branch: "feature/x", expectedCurrentSha: 12345 });
    expect(res.ok).toBe(false);
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
        dryRun: false,
        expectedCurrentSha: null
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
      assigneeAgentId: "agent-1"
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
      assigneeAgentId: "agent-1"
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

  it("uses an isolated execution workspace when the invoking issue is blocked and project id is blank", async () => {
    const ctx = buildCtx({
      issues: [{
        status: "blocked",
        projectId: "issue-project-1",
        executionRunId: "r-1",
        checkoutRunId: "r-1",
        executionWorkspaceId: "execution-workspace-3"
      }],
      executionWorkspace: {
        cwd: "/work/repo/.paperclip/worktrees/feature-x",
        path: null
      }
    });
    ctx.issues.list.mockImplementation(async (input) => input && "status" in input ? [] : [{
      status: "blocked",
      projectId: "issue-project-1",
      executionRunId: "r-1",
      checkoutRunId: "r-1",
      executionWorkspaceId: "execution-workspace-3"
    }]);
    __setGitCommandRunnerForTests(async ({ cwd }) => ({
      exitCode: 0,
      stdout: cwd.endsWith("/.paperclip/worktrees/feature-x")
        ? "https://github.com/acme/widgets.git\n"
        : "",
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
      assigneeAgentId: "agent-1"
    });
    expect(ctx.executionWorkspaces.get).toHaveBeenCalledWith("execution-workspace-3", "co-1");
    expect(ctx.projects.getPrimaryWorkspace).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({
      ok: true,
      ref: expect.objectContaining({
        workspacePath: "/work/repo/.paperclip/worktrees/feature-x"
      })
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

  it("falls back through the matching issue project when the tool run project id is blank", async () => {
    const ctx = buildCtx({
      issues: [{
        projectId: "issue-project-1",
        executionRunId: "r-1",
        checkoutRunId: null,
        executionWorkspaceId: "execution-workspace-1"
      }],
      executionWorkspace: null
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

    expect(ctx.projects.getPrimaryWorkspace).toHaveBeenCalledWith("issue-project-1", "co-1");
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
      assigneeAgentId: "agent-1"
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

  it("accepts a valid full-length hex expectedCurrentSha and resolves it onto the ref", async () => {
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 0,
      stdout: "https://github.com/acme/widgets.git\n",
      stderr: ""
    }));
    const sha = "24a86a4c3a8c2cad076682ae9c64f937a4ab6b88";
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x", expectedCurrentSha: sha },
      identity,
      ctx: buildCtx() as never,
      runCtx
    });
    expect(res).toEqual({
      ok: true,
      ref: expect.objectContaining({ expectedCurrentSha: sha })
    });
  });

  it("rejects an empty expectedCurrentSha before credential resolution", async () => {
    const ctx = buildCtx();
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x", expectedCurrentSha: "   " },
      identity,
      ctx: ctx as never,
      runCtx
    });
    expect(res).toEqual({
      ok: false,
      error: "Invalid expectedCurrentSha. Provide a full 40-character hex commit SHA to force-with-lease, or omit for a normal push."
    });
  });

  it("rejects an abbreviated expectedCurrentSha", async () => {
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x", expectedCurrentSha: "24a86a4" },
      identity,
      ctx: buildCtx() as never,
      runCtx
    });
    expect(res).toEqual({
      ok: false,
      error: "Invalid expectedCurrentSha. Provide a full 40-character hex commit SHA to force-with-lease, or omit for a normal push."
    });
  });

  it("rejects a non-hex expectedCurrentSha", async () => {
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x", expectedCurrentSha: "z".repeat(40) },
      identity,
      ctx: buildCtx() as never,
      runCtx
    });
    expect(res).toEqual({
      ok: false,
      error: "Invalid expectedCurrentSha. Provide a full 40-character hex commit SHA to force-with-lease, or omit for a normal push."
    });
  });

  it("rejects a revision expression instead of a literal SHA for expectedCurrentSha", async () => {
    const res = await githubPushBranchToolSpec.resolveResourceRef!({
      params: { branch: "feature/x", expectedCurrentSha: "HEAD~1" },
      identity,
      ctx: buildCtx() as never,
      runCtx
    });
    expect(res.ok).toBe(false);
  });
});

describe("githubPushBranchToolSpec.perform", () => {
  function target(overrides: Partial<GitHubPushTarget> = {}): GitHubPushTarget {
    return {
      kind: "github-push-target",
      owner: "acme",
      repo: "widgets",
      fullName: "acme/widgets",
      workspacePath: "/work/repo",
      remoteName: "origin",
      branch: "feature/x",
      dryRun: false,
      expectedCurrentSha: null,
      ...overrides
    };
  }

  function execution(
    token: string | null,
    ref: GitHubPushTarget | null,
    ctx: unknown = buildCtx()
  ): ProviderToolExecution<GitHubAgentIdentity, GitHubPushTarget> {
    return {
      token,
      identity,
      resourceRef: ref,
      params: { branch: "feature/x" },
      ctx: ctx as never,
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

  it("defaults to a plain non-force push when expectedCurrentSha is omitted", async () => {
    const commands: string[][] = [];
    __setGitCommandRunnerForTests(async ({ args }) => {
      commands.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await githubPushBranchToolSpec.perform(execution("tok", target()));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual([
      "-c",
      "credential.helper=",
      "push",
      "https://github.com/acme/widgets.git",
      "HEAD:refs/heads/feature/x"
    ]);
  });

  it("pushes with a ref-scoped force-with-lease when expectedCurrentSha is set", async () => {
    const sha = "24a86a4c3a8c2cad076682ae9c64f937a4ab6b88";
    const commands: string[][] = [];
    __setGitCommandRunnerForTests(async ({ args }) => {
      commands.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const result = (await githubPushBranchToolSpec.perform(
      execution("tok", target({ expectedCurrentSha: sha }))
    )) as { content: string; data: { forceWithLease: boolean } };

    expect(commands[0]).toEqual([
      "-c",
      "credential.helper=",
      "push",
      `--force-with-lease=refs/heads/feature/x:${sha}`,
      "https://github.com/acme/widgets.git",
      "HEAD:refs/heads/feature/x"
    ]);
    expect(result.content).toContain("Push succeeded for acme/widgets:feature/x.");
    expect(result.data.forceWithLease).toBe(true);
  });

  it("never emits an unguarded --force even when expectedCurrentSha is set", async () => {
    const sha = "24a86a4c3a8c2cad076682ae9c64f937a4ab6b88";
    const commands: string[][] = [];
    __setGitCommandRunnerForTests(async ({ args }) => {
      commands.push(args);
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await githubPushBranchToolSpec.perform(execution("tok", target({ expectedCurrentSha: sha })));
    expect(commands[0]).not.toContain("--force");
    expect(commands[0]).not.toContain("-f");
  });

  it("surfaces a stale-lease rejection as a push failure without retrying unguarded", async () => {
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "! [rejected]        feature/x -> feature/x (stale info)\n" +
        "error: failed to push some refs to 'https://github.com/acme/widgets.git'\n"
    }));
    const sha = "24a86a4c3a8c2cad076682ae9c64f937a4ab6b88";
    const ctx = buildCtx();
    const result = (await githubPushBranchToolSpec.perform(
      execution("tok", target({ expectedCurrentSha: sha }), ctx)
    )) as { error: string; data: { stderr: string } };

    expect(result.error).toBe("git push failed for 'acme/widgets' branch 'feature/x'.");
    expect(result.data.stderr).toContain("stale info");
    expect(ctx.activity.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: "push_failed_stale_lease" })
      })
    );
  });

  it("tags a non-stale leased push failure (e.g. auth) with a neutral outcome, not stale-lease", async () => {
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "remote: Repository not found.\n" +
        "fatal: Authentication failed for 'https://github.com/acme/widgets.git/'\n"
    }));
    const sha = "24a86a4c3a8c2cad076682ae9c64f937a4ab6b88";
    const ctx = buildCtx();
    const result = (await githubPushBranchToolSpec.perform(
      execution("tok", target({ expectedCurrentSha: sha }), ctx)
    )) as { error: string; data: { stderr: string } };

    expect(result.error).toBe("git push failed for 'acme/widgets' branch 'feature/x'.");
    expect(result.data.stderr).toContain("Authentication failed");
    expect(ctx.activity.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: "push_failed_force_with_lease" })
      })
    );
    expect(ctx.activity.log).not.toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ outcome: "push_failed_stale_lease" })
      })
    );
  });

  it("redacts the credential token from stdout/stderr on a force-with-lease push", async () => {
    const token = "gh-secret-token-value";
    __setGitCommandRunnerForTests(async () => ({
      exitCode: 1,
      stdout: `remote: using ${token} for auth\n`,
      stderr: `fatal: authentication failed for ${token}\n`
    }));
    const sha = "24a86a4c3a8c2cad076682ae9c64f937a4ab6b88";
    const result = (await githubPushBranchToolSpec.perform(
      execution(token, target({ expectedCurrentSha: sha }))
    )) as { data: { stdout: string; stderr: string } };

    expect(result.data.stdout).not.toContain(token);
    expect(result.data.stderr).not.toContain(token);
    expect(result.data.stdout).toContain("[REDACTED]");
    expect(result.data.stderr).toContain("[REDACTED]");
  });
});
