import { describe, it, expect, vi } from "vitest";
import {
  computeAggregateState,
  dropSupersededWorkflowRuns,
  githubGetPullRequestChecksToolSpec
} from "../../../src/providers/github/tools/get-pull-request-checks.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

function repoRef(): GitHubRepoRef {
  return { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" };
}

function buildCtx(fetchImpl: typeof fetch) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() }
  } as never;
}

describe("githubGetPullRequestChecksToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubGetPullRequestChecksToolSpec.validateParams({ pullNumber: 1 })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid pullNumber", () => {
    expect(
      githubGetPullRequestChecksToolSpec.validateParams({ repository: "acme/widgets" })
    ).toEqual({ ok: false, error: "pullNumber must be a positive integer" });

    expect(
      githubGetPullRequestChecksToolSpec.validateParams({ repository: "acme/widgets", pullNumber: -1 })
    ).toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("accepts valid params", () => {
    expect(
      githubGetPullRequestChecksToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7 })
    ).toEqual({ ok: true, params: { repository: "acme/widgets", pullNumber: 7 } });
  });
});

describe("githubGetPullRequestChecksToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubGetPullRequestChecksToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository before any credential is resolved", async () => {
    const res = await githubGetPullRequestChecksToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", pullNumber: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubGetPullRequestChecksToolSpec.perform", () => {
  function execution(token: string | null): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      tokenSource: "github-app",
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", pullNumber: 7 },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null (identity verified, no secret minted)", async () => {
    const result = (await githubGetPullRequestChecksToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("fetches the PR head sha, then check-runs/status/actions-runs for that sha", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith("/pulls/7")) {
        return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), { status: 200 });
      }
      if (url.includes("/commits/deadbeef/check-runs")) {
        return new Response(JSON.stringify({
          total_count: 1,
          check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success", started_at: "t1", completed_at: "t2", html_url: "u1" }]
        }), { status: 200 });
      }
      if (url.includes("/commits/deadbeef/status")) {
        return new Response(JSON.stringify({
          state: "success",
          statuses: [{ context: "ci/legacy", state: "success", description: "ok", target_url: "u2" }]
        }), { status: 200 });
      }
      if (url.includes("/actions/runs")) {
        return new Response(JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 2, name: "CI", status: "completed", conclusion: "success", html_url: "u3", run_started_at: "t3" }]
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as {
      content: string;
      data: { sha: string; overallState: string; checkRuns: unknown[]; statusContexts: unknown[]; workflowRuns: unknown[] };
    };
    expect(calls).toContain("https://api.github.com/repos/acme/widgets/pulls/7");
    expect(calls).toContain("https://api.github.com/repos/acme/widgets/commits/deadbeef/check-runs?per_page=100");
    expect(calls).toContain("https://api.github.com/repos/acme/widgets/commits/deadbeef/status");
    expect(calls).toContain("https://api.github.com/repos/acme/widgets/actions/runs?head_sha=deadbeef&per_page=100");
    expect(result.data.sha).toBe("deadbeef");
    expect(result.data.overallState).toBe("success");
    expect(result.data.checkRuns).toHaveLength(1);
    expect(result.data.statusContexts).toHaveLength(1);
    expect(result.data.workflowRuns).toHaveLength(1);
  });

  it("explains why a listed cancelled run did not make the verdict red", async () => {
    // Without this, a reader sees `success` next to a `cancelled` run in the same
    // payload with nothing connecting them, which reads as a bug in the tool.
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/7")) {
        return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), { status: 200 });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "success", statuses: [] }), { status: 200 });
      }
      if (url.includes("/actions/runs")) {
        return new Response(JSON.stringify({
          total_count: 2,
          workflow_runs: [
            { id: 1, workflow_id: 99, event: "pull_request", name: "CI", status: "completed", conclusion: "cancelled", html_url: "u1", run_started_at: "t1" },
            { id: 2, workflow_id: 99, event: "pull_request", name: "CI", status: "completed", conclusion: "success", html_url: "u2", run_started_at: "t2" }
          ]
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as {
      content: string;
      data: { overallState: string; supersededWorkflowRuns?: number; workflowRuns: unknown[] };
    };
    expect(result.data.overallState).toBe("success");
    // The displaced run is still listed — only the verdict ignores it.
    expect(result.data.workflowRuns).toHaveLength(2);
    expect(result.data.supersededWorkflowRuns).toBe(1);
    expect(result.content).toContain("1 workflow run(s) listed but excluded from the status as superseded");
  });

  it("omits the superseded count entirely when nothing was displaced", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/7")) {
        return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), { status: 200 });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ total_count: 0, check_runs: [] }), { status: 200 });
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "success", statuses: [] }), { status: 200 });
      }
      if (url.includes("/actions/runs")) {
        return new Response(JSON.stringify({
          total_count: 1,
          workflow_runs: [{ id: 2, workflow_id: 99, name: "CI", status: "completed", conclusion: "success", html_url: "u2", run_started_at: "t2" }]
        }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as {
      content: string;
      data: { supersededWorkflowRuns?: number };
    };
    expect(result.data.supersededWorkflowRuns).toBeUndefined();
    expect(result.content).not.toContain("superseded");
  });

  it("never reports success from a page that did not carry every check run", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/7")) {
        return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), { status: 200 });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({
          total_count: 142,
          check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "success", started_at: null, completed_at: null, html_url: "u1" }]
        }), { status: 200 });
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "success", statuses: [] }), { status: 200 });
      }
      if (url.includes("/actions/runs")) {
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as {
      content: string;
      data: { overallState: string; truncated?: string[] };
    };
    expect(result.data.overallState).toBe("pending");
    expect(result.data.truncated).toEqual(["check runs (read 1 of 142)"]);
    expect(result.content).toContain("Incomplete read of check runs (read 1 of 142)");
  });

  it("never reports success from a full page that reported no usable total", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/7")) {
        return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), { status: 200 });
      }
      if (url.includes("/check-runs")) {
        // 100 green runs — exactly the page cap — with `total_count` absent.
        // Indistinguishable from a truncated read, so it cannot report green.
        return new Response(JSON.stringify({
          check_runs: Array.from({ length: 100 }, (_unused, index) => ({
            id: index, name: `build-${index}`, status: "completed", conclusion: "success",
            started_at: null, completed_at: null, html_url: `u${index}`
          }))
        }), { status: 200 });
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "success", statuses: [] }), { status: 200 });
      }
      if (url.includes("/actions/runs")) {
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as {
      data: { overallState: string; truncated?: string[] };
    };
    expect(result.data.overallState).toBe("pending");
    expect(result.data.truncated).toEqual(["check runs (read 100; GitHub reported no usable total)"]);
  });

  it("still reports failure from a truncated page — a red run we did read is still red", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/pulls/7")) {
        return new Response(JSON.stringify({ head: { sha: "deadbeef" } }), { status: 200 });
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({
          total_count: 142,
          check_runs: [{ id: 1, name: "build", status: "completed", conclusion: "failure", started_at: null, completed_at: null, html_url: "u1" }]
        }), { status: 200 });
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "success", statuses: [] }), { status: 200 });
      }
      if (url.includes("/actions/runs")) {
        return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as {
      data: { overallState: string };
    };
    expect(result.data.overallState).toBe("failure");
  });

  it("surfaces a GitHub API error when the PR lookup fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("404");
    expect(result.error).toContain("Not Found");
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestChecksToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });
});

describe("computeAggregateState", () => {
  const done = (conclusion: string | null) => ({ status: "completed", conclusion });
  const running = () => ({ status: "in_progress", conclusion: null });

  it("reports failure when a check run failed even though legacy statuses are green", () => {
    expect(computeAggregateState("success", 1, [done("failure")], [])).toBe("failure");
  });

  it("reports failure when a workflow run failed even though legacy statuses are green", () => {
    expect(computeAggregateState("success", 1, [], [done("timed_out")])).toBe("failure");
  });

  it("reports success when every signal passed", () => {
    expect(computeAggregateState("success", 1, [done("success")], [done("skipped")])).toBe("success");
  });

  it("treats neutral and skipped conclusions as non-blocking passes", () => {
    expect(computeAggregateState("success", 1, [done("neutral")], [done("skipped")])).toBe("success");
  });

  it("reports pending while a run is still in progress", () => {
    expect(computeAggregateState("success", 1, [running()], [])).toBe("pending");
  });

  it("reports pending when a completed run has no conclusion", () => {
    expect(computeAggregateState("success", 1, [done(null)], [])).toBe("pending");
  });

  it("reports pending when there are no signals at all", () => {
    expect(computeAggregateState("pending", 0, [], [])).toBe("pending");
  });

  it("reports success from check runs alone when there are no legacy status contexts", () => {
    expect(computeAggregateState("pending", 0, [done("success")], [])).toBe("success");
  });

  it("reports failure from a legacy status error", () => {
    expect(computeAggregateState("error", 2, [done("success")], [])).toBe("failure");
  });

  it("lets a failure outrank a pending run", () => {
    expect(computeAggregateState("success", 1, [running(), done("failure")], [])).toBe("failure");
  });
});

describe("dropSupersededWorkflowRuns", () => {
  const run = (id: number, workflowId: number, conclusion: string | null, event = "pull_request") => ({
    id,
    workflow_id: workflowId,
    event,
    status: "completed",
    conclusion
  });

  it("drops a cancelled run that a later run of the same workflow displaced", () => {
    // The `concurrency: cancel-in-progress` artifact. Nothing ever rewrites
    // run 1, so keeping it would make the commit permanently un-mergeable.
    const kept = dropSupersededWorkflowRuns([run(1, 99, "cancelled"), run(2, 99, "success")]);
    expect(kept.map((r) => r.id)).toEqual([2]);
  });

  it("keeps a cancelled run that is still the newest for its workflow", () => {
    const kept = dropSupersededWorkflowRuns([run(1, 99, "success"), run(2, 99, "cancelled")]);
    expect(kept.map((r) => r.id)).toEqual([1, 2]);
  });

  it("does not let one workflow's later run excuse another workflow's cancellation", () => {
    const kept = dropSupersededWorkflowRuns([run(1, 99, "cancelled"), run(2, 42, "success")]);
    expect(kept.map((r) => r.id)).toEqual([1, 2]);
  });

  it("does not let a later run from another event excuse a cancellation", () => {
    const kept = dropSupersededWorkflowRuns([
      run(100, 99, "cancelled", "pull_request"),
      run(200, 99, "success", "workflow_dispatch")
    ]);
    expect(kept.map((r) => r.id)).toEqual([100, 200]);
  });

  it("never drops a real verdict, only a displaced one", () => {
    // `failure` is a judgement, not a cancellation — a later run must not bury it.
    const kept = dropSupersededWorkflowRuns([run(1, 99, "failure"), run(2, 99, "success")]);
    expect(kept.map((r) => r.id)).toEqual([1, 2]);
  });

  it("also drops a displaced `stale` run", () => {
    const kept = dropSupersededWorkflowRuns([run(1, 99, "stale"), run(2, 99, "success")]);
    expect(kept.map((r) => r.id)).toEqual([2]);
  });

  it("keeps a cancelled run when ids are missing, since displacement cannot be proven", () => {
    const kept = dropSupersededWorkflowRuns([
      { status: "completed", conclusion: "cancelled" },
      { status: "completed", conclusion: "success" }
    ]);
    expect(kept).toHaveLength(2);
  });

  it("leaves a clean set untouched", () => {
    const kept = dropSupersededWorkflowRuns([run(1, 99, "success"), run(2, 42, "success")]);
    expect(kept.map((r) => r.id)).toEqual([1, 2]);
  });
});
