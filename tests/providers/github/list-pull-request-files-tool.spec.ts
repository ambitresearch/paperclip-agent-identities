import { describe, it, expect, vi } from "vitest";
import { githubListPullRequestFilesToolSpec } from "../../../src/providers/github/tools/list-pull-request-files.js";
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

describe("githubListPullRequestFilesToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubListPullRequestFilesToolSpec.validateParams({ pullNumber: 1 })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects perPage over the cap", () => {
    expect(
      githubListPullRequestFilesToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, perPage: 200 })
    ).toEqual({ ok: false, error: "perPage must be a positive integer up to 100 if provided" });
  });

  it("accepts valid params", () => {
    expect(
      githubListPullRequestFilesToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, page: 2, perPage: 10 }).ok
    ).toBe(true);
  });
});

describe("githubListPullRequestFilesToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubListPullRequestFilesToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });
});

describe("githubListPullRequestFilesToolSpec.perform", () => {
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

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubListPullRequestFilesToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("lists changed files and reports hasMore from the Link header", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/files?page=1&per_page=30");
      return new Response(
        JSON.stringify([{ filename: "src/a.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1,1 +1,3 @@" }]),
        { status: 200, headers: { Link: '<https://api.github.com/x?page=2>; rel="next"' } }
      );
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubListPullRequestFilesToolSpec.perform(exec)) as { data: { files: unknown[]; hasMore: boolean } };
    expect(result.data.files).toHaveLength(1);
    expect(result.data.hasMore).toBe(true);
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubListPullRequestFilesToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubListPullRequestFilesToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("404");
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubListPullRequestFilesToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});
