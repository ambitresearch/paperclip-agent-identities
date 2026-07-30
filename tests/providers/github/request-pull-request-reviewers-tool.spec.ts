import { describe, it, expect, vi } from "vitest";
import { githubRequestPullRequestReviewersToolSpec } from "../../../src/providers/github/tools/request-pull-request-reviewers.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

function repoRef(): GitHubRepoRef {
  return { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" };
}

function buildCtx(fetchImpl: typeof fetch, activityLog = vi.fn()) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog }
  } as never;
}

describe("githubRequestPullRequestReviewersToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubRequestPullRequestReviewersToolSpec.validateParams({ pullNumber: 1, reviewers: ["alice"] })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid pullNumber", () => {
    expect(
      githubRequestPullRequestReviewersToolSpec.validateParams({ repository: "acme/widgets", reviewers: ["alice"] })
    ).toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("requires at least one reviewer or team reviewer", () => {
    expect(
      githubRequestPullRequestReviewersToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1 })
    ).toEqual({ ok: false, error: "at least one of reviewers or teamReviewers is required" });
  });

  it("rejects a malformed reviewers entry", () => {
    expect(
      githubRequestPullRequestReviewersToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, reviewers: [""] })
    ).toEqual({ ok: false, error: "reviewers[0] must be a non-empty string" });
  });

  it("accepts reviewers only", () => {
    const res = githubRequestPullRequestReviewersToolSpec.validateParams({
      repository: "acme/widgets", pullNumber: 1, reviewers: ["alice", "bob"]
    });
    expect(res).toEqual({
      ok: true,
      params: { repository: "acme/widgets", pullNumber: 1, reviewers: ["alice", "bob"], teamReviewers: undefined, paperclipIssueId: undefined }
    });
  });

  it("accepts teamReviewers only", () => {
    const res = githubRequestPullRequestReviewersToolSpec.validateParams({
      repository: "acme/widgets", pullNumber: 1, teamReviewers: ["platform"]
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a non-string paperclipIssueId", () => {
    expect(
      githubRequestPullRequestReviewersToolSpec.validateParams({
        repository: "acme/widgets", pullNumber: 1, reviewers: ["alice"], paperclipIssueId: 123
      })
    ).toEqual({ ok: false, error: "paperclipIssueId must be a string if provided" });
  });
});

describe("githubRequestPullRequestReviewersToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubRequestPullRequestReviewersToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 1, reviewers: ["alice"] },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository before any credential is resolved", async () => {
    const res = await githubRequestPullRequestReviewersToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", pullNumber: 1, reviewers: ["alice"] },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubRequestPullRequestReviewersToolSpec.perform", () => {
  function execution(
    token: string | null,
    overrides: Partial<{ reviewers?: string[]; teamReviewers?: string[] }> = {}
  ): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: {
        repository: "acme/widgets",
        pullNumber: 7,
        reviewers: overrides.reviewers ?? ["alice"],
        teamReviewers: overrides.teamReviewers
      },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null (identity verified, no secret minted)", async () => {
    const result = (await githubRequestPullRequestReviewersToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("posts reviewers and team_reviewers to the requested_reviewers API", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.reviewers).toEqual(["alice"]);
      expect(body.team_reviewers).toEqual(["platform"]);
      return new Response(
        JSON.stringify({
          number: 7,
          html_url: "https://github.com/acme/widgets/pull/7",
          requested_reviewers: [{ login: "alice" }],
          requested_teams: [{ slug: "platform" }]
        }),
        { status: 201 }
      );
    });
    const exec = execution("tok", { reviewers: ["alice"], teamReviewers: ["platform"] });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubRequestPullRequestReviewersToolSpec.perform(exec)) as {
      content: string;
      data: { requestedReviewers: string[]; requestedTeams: string[] };
    };
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/requested_reviewers");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect(result.data.requestedReviewers).toEqual(["alice"]);
    expect(result.data.requestedTeams).toEqual(["platform"]);
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/pull/7", requested_reviewers: [{ login: "alice" }] }),
      { status: 201 }
    ));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubRequestPullRequestReviewersToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubRequestPullRequestReviewersToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ message: "Reviews may not be requested from the PR author" }),
      { status: 422 }
    ));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubRequestPullRequestReviewersToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("422");
    expect(result.error).toContain("Reviews may not be requested from the PR author");
  });
});
