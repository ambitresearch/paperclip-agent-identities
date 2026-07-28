import { describe, it, expect, vi } from "vitest";
import { githubGetIssueToolSpec } from "../../../src/providers/github/tools/get-issue.js";
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

describe("githubGetIssueToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubGetIssueToolSpec.validateParams({ issueNumber: 1 })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid issueNumber", () => {
    expect(
      githubGetIssueToolSpec.validateParams({ repository: "acme/widgets" })
    ).toEqual({ ok: false, error: "issueNumber must be a positive integer" });
  });

  it("accepts valid params", () => {
    expect(githubGetIssueToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 1 }).ok).toBe(true);
  });
});

describe("githubGetIssueToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubGetIssueToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", issueNumber: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });
});

describe("githubGetIssueToolSpec.perform", () => {
  function execution(token: string | null): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", issueNumber: 7 },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubGetIssueToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("fetches the issue and returns core fields", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/7");
      return new Response(
        JSON.stringify({
          number: 7,
          title: "Bug",
          body: "It broke",
          state: "open",
          html_url: "https://github.com/acme/widgets/issues/7",
          assignees: [{ login: "alice" }],
          labels: [{ name: "bug" }, "urgent"],
          milestone: { number: 3, title: "v1" }
        }),
        { status: 200 }
      );
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetIssueToolSpec.perform(exec)) as { data: { title: string; assignees: string[]; labels: string[] } };
    expect(result.data.title).toBe("Bug");
    expect(result.data.assignees).toEqual(["alice"]);
    expect(result.data.labels).toEqual(["bug", "urgent"]);
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetIssueToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubGetIssueToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("404");
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 7, title: "Bug", body: "", state: "open", html_url: "u", assignees: [], labels: [], milestone: null }),
      { status: 200 }
    ));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubGetIssueToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});
