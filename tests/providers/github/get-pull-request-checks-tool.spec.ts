import { describe, it, expect, vi } from "vitest";
import {
  computeAggregateState,
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
    expect(calls).toContain("https://api.github.com/repos/acme/widgets/commits/deadbeef/check-runs");
    expect(calls).toContain("https://api.github.com/repos/acme/widgets/commits/deadbeef/status");
    expect(calls).toContain("https://api.github.com/repos/acme/widgets/actions/runs?head_sha=deadbeef");
    expect(result.data.sha).toBe("deadbeef");
    expect(result.data.overallState).toBe("success");
    expect(result.data.checkRuns).toHaveLength(1);
    expect(result.data.statusContexts).toHaveLength(1);
    expect(result.data.workflowRuns).toHaveLength(1);
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
