import { describe, it, expect, vi } from "vitest";
import { githubGetPullRequestToolSpec } from "../../../src/providers/github/tools/get-pull-request.js";
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

describe("githubGetPullRequestToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubGetPullRequestToolSpec.validateParams({ pullNumber: 1 })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid pullNumber", () => {
    expect(
      githubGetPullRequestToolSpec.validateParams({ repository: "acme/widgets" })
    ).toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("accepts valid params", () => {
    expect(githubGetPullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1 }).ok).toBe(true);
  });
});

describe("githubGetPullRequestToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubGetPullRequestToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });
});

describe("githubGetPullRequestToolSpec.perform", () => {
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

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubGetPullRequestToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("fetches the pull request and returns core fields", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls/7");
      return new Response(
        JSON.stringify({
          number: 7,
          title: "Feature",
          body: "Adds a thing",
          state: "open",
          html_url: "https://github.com/acme/widgets/pull/7",
          draft: false,
          merged: false,
          mergeable: true,
          mergeable_state: "clean",
          head: { ref: "feature-branch" },
          base: { ref: "main" },
          requested_reviewers: [{ login: "bob" }]
        }),
        { status: 200 }
      );
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestToolSpec.perform(exec)) as {
      data: { head: string; base: string; requestedReviewers: string[] };
    };
    expect(result.data.head).toBe("feature-branch");
    expect(result.data.base).toBe("main");
    expect(result.data.requestedReviewers).toEqual(["bob"]);
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetPullRequestToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("404");
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        number: 7, title: "t", body: "", state: "open", html_url: "u", draft: false, merged: false,
        mergeable: true, mergeable_state: "clean", head: { ref: "h" }, base: { ref: "b" }, requested_reviewers: []
      }),
      { status: 200 }
    ));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubGetPullRequestToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});
