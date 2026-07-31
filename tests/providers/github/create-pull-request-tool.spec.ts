import { describe, it, expect, vi, afterEach } from "vitest";
import {
  githubCreatePullRequestToolSpec
} from "../../../src/providers/github/tools/create-pull-request.js";
import {
  __setGitCommandRunnerForTests,
  __resetGitCommandRunnerForTests
} from "../../../src/providers/github/tools/push-branch.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type {
  ProviderToolExecution
} from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

function repoRef(): GitHubRepoRef {
  return { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" };
}

function buildCtx(
  fetchImpl: typeof fetch,
  activityLog = vi.fn(),
  workspacePath = "/work/repo",
  stateStore: Record<string, unknown> = {}
) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog },
    projects: { getPrimaryWorkspace: vi.fn(async () => ({ path: workspacePath })) },
    issues: { list: vi.fn(async () => []) },
    executionWorkspaces: { get: vi.fn(async () => null) },
    state: {
      get: vi.fn(async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) => {
        const storeKey = `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? "default"}:${key.stateKey}`;
        return storeKey in stateStore ? stateStore[storeKey] : null;
      }),
      set: vi.fn(async (key: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }, value: unknown) => {
        const storeKey = `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? "default"}:${key.stateKey}`;
        stateStore[storeKey] = value;
      })
    }
  } as never;
}

afterEach(() => {
  __resetGitCommandRunnerForTests();
});

describe("githubCreatePullRequestToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(githubCreatePullRequestToolSpec.validateParams({ head: "a", base: "b", title: "t" }))
      .toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("accepts a full valid param set", () => {
    const res = githubCreatePullRequestToolSpec.validateParams({
      repository: "acme/widgets", head: "feature", base: "main", title: "My PR"
    });
    expect(res.ok).toBe(true);
  });
});

describe("githubCreatePullRequestToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubCreatePullRequestToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", head: "f", base: "main", title: "t" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository", async () => {
    const res = await githubCreatePullRequestToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", head: "f", base: "main", title: "t" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubCreatePullRequestToolSpec.perform", () => {
  function execution(token: string | null): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      tokenSource: "github-app",
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", head: "feature", base: "main", title: "My PR" },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubCreatePullRequestToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("awaits the activity audit write before returning success", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: false, head: { ref: "feature" }, base: { ref: "main" } }),
      { status: 201 }
    ));
    let finishLog: (() => void) | undefined;
    const activityLog = vi.fn(() => new Promise<void>((resolve) => { finishLog = resolve; }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    let settled = false;
    const result = githubCreatePullRequestToolSpec.perform(exec).then(() => { settled = true; });
    await vi.waitFor(() => expect(activityLog).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishLog?.();
    await result;
  });

  it("posts to the GitHub PR API and returns the created PR", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => new Response(
      JSON.stringify({ number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: false, head: { ref: "feature" }, base: { ref: "main" } }),
      { status: 201 }
    ));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as { content: string; data: { number: number } };
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("paperclip-agent-identities/github-api");
    expect(result.data.number).toBe(42);
    expect(result.content).toContain("#42");
  });

  it("links the created PR to the Paperclip issue when paperclipIssueId is supplied", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: false, head: { ref: "feature" }, base: { ref: "main" } }),
      { status: 201 }
    ));
    const stateStore: Record<string, unknown> = {};
    const exec = execution("tok");
    (exec.params as Record<string, unknown>).paperclipIssueId = "iss-1";
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, vi.fn(), "/work/repo", stateStore);
    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as {
      data: { number: number; linked: boolean };
    };
    expect(result.data.linked).toBe(true);
    expect(stateStore["issue:iss-1:github-links:links"]).toEqual([
      {
        githubUrl: "https://github.com/acme/widgets/pull/42",
        note: null,
        linkedByAgentId: "agent-1",
        linkedAt: expect.any(String)
      }
    ]);
  });

  it("reports linkError but does not fail the PR creation when link persistence fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: false, head: { ref: "feature" }, base: { ref: "main" } }),
      { status: 201 }
    ));
    const exec = execution("tok");
    (exec.params as Record<string, unknown>).paperclipIssueId = "iss-1";
    (exec as { ctx: unknown }).ctx = {
      http: { fetch: fetchImpl },
      logger: { info: vi.fn(), error: vi.fn() },
      activity: { log: vi.fn() },
      state: {
        get: vi.fn(async () => { throw new Error("storage down"); }),
        set: vi.fn()
      }
    } as never;
    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as {
      data: { number: number; linked: boolean; linkError?: string };
    };
    // The PR itself must still be reported as created successfully.
    expect(result.data.number).toBe(42);
    expect(result.data.linked).toBe(false);
    expect(result.data.linkError).toBeTruthy();
  });

  it("does not attempt to link when paperclipIssueId is omitted", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: false, head: { ref: "feature" }, base: { ref: "main" } }),
      { status: 201 }
    ));
    const stateStore: Record<string, unknown> = {};
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, vi.fn(), "/work/repo", stateStore);
    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as {
      data: { number: number; linked?: boolean };
    };
    expect(result.data.linked).toBeUndefined();
    expect(Object.keys(stateStore)).toHaveLength(0);
  });
});

const SHA = "a".repeat(40);

function execWithCommit(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    token: "tok",
    identity: { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } },
    resourceRef: repoRef(),
    params: {
      repository: "acme/widgets",
      head: "feature",
      base: "main",
      title: "My PR",
      commit: SHA,
      ...overrides
    },
    ctx: buildCtx(vi.fn() as never),
    runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" }
  } as unknown as ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef>;
}

describe("githubCreatePullRequestToolSpec.perform - exact-commit publish (DRO-1173)", () => {
  it("publishes the branch at the exact local HEAD commit, verifies, then creates the PR", async () => {
    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (args.includes("push")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected git args" };
    });

    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/git/ref/heads%2Ffeature") && (!init || init.method === "GET" || init.method === undefined)) {
        // First call: pre-existing check -> not found. Second call: verify -> matches.
        const call = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/git/ref/heads%2Ffeature")).length;
        if (call <= 1) {
          return new Response(null, { status: 404 });
        }
        return new Response(JSON.stringify({ object: { sha: SHA } }), { status: 200 });
      }
      if (String(url).endsWith("/pulls")) {
        return new Response(
          JSON.stringify({
            number: 7,
            html_url: "https://github.com/acme/widgets/pull/7",
            state: "open",
            draft: false,
            head: { ref: "feature" },
            base: { ref: "main" }
          }),
          { status: 201 }
        );
      }
      return new Response(null, { status: 500 });
    });

    const exec = execWithCommit();
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as {
      content: string;
      data: { number: number; commit: string };
    };

    expect(result.data.number).toBe(7);
    expect(result.data.commit).toBe(SHA);
    expect(result.content).toContain("#7");

    const prCall = fetchImpl.mock.calls.find(([url]) => String(url).endsWith("/pulls"));
    expect(prCall).toBeTruthy();
  });

  it("fails closed when local HEAD does not match the requested commit", async () => {
    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }));
    const exec = execWithCommit();
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("does not match the requested exact commit");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the remote branch verification does not match the requested commit", async () => {
    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (args.includes("push")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    let refCalls = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/git/ref/heads%2Ffeature")) {
        refCalls += 1;
        if (refCalls === 1) {
          return new Response(null, { status: 404 });
        }
        // verification returns a different sha than requested
        return new Response(JSON.stringify({ object: { sha: "c".repeat(40) } }), { status: 200 });
      }
      return new Response(null, { status: 500 });
    });

    const exec = execWithCommit();
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("landed at");
  });

  it("rolls back the newly-created remote branch when PR creation fails after push", async () => {
    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (args.includes("push")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    let refCalls = 0;
    let deleteCalled = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/git/refs/heads%2Ffeature") && init?.method === "DELETE") {
        deleteCalled = true;
        return new Response(null, { status: 204 });
      }
      if (String(url).includes("/git/ref/heads%2Ffeature")) {
        refCalls += 1;
        if (refCalls === 1) {
          return new Response(null, { status: 404 }); // did not pre-exist
        }
        return new Response(JSON.stringify({ object: { sha: SHA } }), { status: 200 }); // verified ok
      }
      if (String(url).endsWith("/pulls")) {
        return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
      }
      return new Response(null, { status: 500 });
    });

    const exec = execWithCommit();
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as {
      error: string;
      data: { rollback: { attempted: boolean; ok?: boolean } };
    };

    expect(result.error).toContain("GitHub API returned 422");
    expect(result.data.rollback.attempted).toBe(true);
    expect(result.data.rollback.ok).toBe(true);
    expect(deleteCalled).toBe(true);
  });

  it("does not roll back a branch that already existed remotely before the push", async () => {
    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (args.includes("push")) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    let refCalls = 0;
    let deleteCalled = false;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/git/refs/heads%2Ffeature") && init?.method === "DELETE") {
        deleteCalled = true;
        return new Response(null, { status: 204 });
      }
      if (String(url).includes("/git/ref/heads%2Ffeature")) {
        refCalls += 1;
        // pre-existing check finds the branch already there (some other sha),
        // verification after push confirms the new sha landed.
        return new Response(
          JSON.stringify({ object: { sha: refCalls === 1 ? "d".repeat(40) : SHA } }),
          { status: 200 }
        );
      }
      if (String(url).endsWith("/pulls")) {
        return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
      }
      return new Response(null, { status: 500 });
    });

    const exec = execWithCommit();
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as {
      data: { rollback: { attempted: boolean } };
    };

    expect(result.data.rollback.attempted).toBe(false);
    expect(deleteCalled).toBe(false);
  });

  it("supports dryRun: pushes without creating a PR", async () => {
    __setGitCommandRunnerForTests(async ({ args }) => {
      if (args[0] === "rev-parse") {
        return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
      }
      if (args.includes("push")) {
        expect(args).toContain("--dry-run");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    });

    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("/git/ref/heads%2Ffeature")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 500 });
    });
    const exec = execWithCommit({ dryRun: true });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as { content: string };
    expect(result.content).toContain("Dry-run publish succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
