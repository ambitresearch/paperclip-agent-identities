import { describe, it, expect, vi } from "vitest";
import { githubSearchRepositoryItemsToolSpec } from "../../../src/providers/github/tools/search-repository-items.js";
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

describe("githubSearchRepositoryItemsToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubSearchRepositoryItemsToolSpec.validateParams({ query: "bug" })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing query", () => {
    expect(
      githubSearchRepositoryItemsToolSpec.validateParams({ repository: "acme/widgets" })
    ).toEqual({ ok: false, error: "query is required" });
  });

  it("rejects an overlong query", () => {
    const result = githubSearchRepositoryItemsToolSpec.validateParams({
      repository: "acme/widgets",
      query: "x".repeat(257)
    });
    expect(result).toEqual({ ok: false, error: "query must be 256 characters or fewer" });
  });

  it("rejects an invalid type", () => {
    expect(
      githubSearchRepositoryItemsToolSpec.validateParams({ repository: "acme/widgets", query: "bug", type: "pull" })
    ).toEqual({ ok: false, error: 'type must be "issue" or "pr"' });
  });

  it("rejects maxResults over the cap", () => {
    expect(
      githubSearchRepositoryItemsToolSpec.validateParams({ repository: "acme/widgets", query: "bug", maxResults: 50 })
    ).toEqual({ ok: false, error: "maxResults must be an integer between 1 and 30" });
  });

  it("rejects an out-of-range page", () => {
    expect(
      githubSearchRepositoryItemsToolSpec.validateParams({ repository: "acme/widgets", query: "bug", page: 0 })
    ).toEqual({ ok: false, error: "page must be an integer between 1 and 34" });
  });

  it("defaults type, maxResults, and page", () => {
    const res = githubSearchRepositoryItemsToolSpec.validateParams({ repository: "acme/widgets", query: "bug" });
    expect(res).toEqual({
      ok: true,
      params: { repository: "acme/widgets", query: "bug", type: "issue", maxResults: 10, page: 1 }
    });
  });

  it("accepts valid overrides", () => {
    const res = githubSearchRepositoryItemsToolSpec.validateParams({
      repository: "acme/widgets", query: "bug", type: "pr", maxResults: 25, page: 3
    });
    expect(res.ok).toBe(true);
  });
});

describe("githubSearchRepositoryItemsToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubSearchRepositoryItemsToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", query: "bug", type: "issue", maxResults: 10, page: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("rejects an invalid repository format", async () => {
    const res = await githubSearchRepositoryItemsToolSpec.resolveResourceRef!({
      params: { repository: "not-a-repo", query: "bug", type: "issue", maxResults: 10, page: 1 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubSearchRepositoryItemsToolSpec.perform", () => {
  function execution(
    token: string | null,
    overrides: Partial<{ query: string; type: string; maxResults: number; page: number }> = {}
  ): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", query: "bug", type: "issue", maxResults: 10, page: 1, ...overrides },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubSearchRepositoryItemsToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("builds the search query and sanitizes returned items", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://api.github.com/search/issues?q=" +
          encodeURIComponent("bug repo:acme/widgets type:issue") +
          "&per_page=10&page=1"
      );
      return new Response(
        JSON.stringify({
          total_count: 42,
          items: [
            {
              number: 7,
              title: "Login crash",
              state: "open",
              html_url: "https://github.com/acme/widgets/issues/7",
              labels: [{ name: "bug" }, "critical"],
              assignees: [{ login: "alice" }],
              node_id: "should-not-leak",
              reactions: { "+1": 3 }
            }
          ]
        }),
        { status: 200 }
      );
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubSearchRepositoryItemsToolSpec.perform(exec)) as {
      data: { totalCount: number; hasMore: boolean; items: Array<Record<string, unknown>> };
    };
    expect(result.data.totalCount).toBe(42);
    expect(result.data.hasMore).toBe(true);
    expect(result.data.items).toEqual([
      { number: 7, title: "Login crash", state: "open", url: "https://github.com/acme/widgets/issues/7", labels: ["bug", "critical"], assignees: ["alice"] }
    ]);
  });

  it("reports hasMore false when the last page is reached", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ total_count: 5, items: [] }), { status: 200 })
    );
    const exec = execution("tok", { page: 1, maxResults: 10 });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubSearchRepositoryItemsToolSpec.perform(exec)) as { data: { hasMore: boolean } };
    expect(result.data.hasMore).toBe(false);
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubSearchRepositoryItemsToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubSearchRepositoryItemsToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("422");
    expect(result.error).toContain("Validation Failed");
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 }));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubSearchRepositoryItemsToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});

describe("githubSearchRepositoryItemsToolSpec.validateParams query scoping", () => {
  const v = (query: string) =>
    githubSearchRepositoryItemsToolSpec.validateParams({ repository: "acme/widgets", query });

  it("rejects a query containing a boolean OR that could widen scope", () => {
    expect(v("bug OR repo:other/repo")).toEqual({
      ok: false,
      error: "query must not contain the boolean operators OR/NOT; they can escape repository scoping"
    });
  });

  it("rejects a query containing NOT", () => {
    expect(v("bug NOT flaky")).toMatchObject({ ok: false });
  });

  it("rejects a caller-supplied repo: qualifier", () => {
    expect(v("repo:evil/repo secrets")).toMatchObject({ ok: false });
  });

  it("rejects caller-supplied org:, user:, and owner: qualifiers", () => {
    expect(v("org:evil secrets")).toMatchObject({ ok: false });
    expect(v("secrets user:evil")).toMatchObject({ ok: false });
    expect(v("secrets -owner:evil")).toMatchObject({ ok: false });
  });

  it("still accepts an ordinary scoped-safe query", () => {
    expect(v("flaky test in:title")).toMatchObject({ ok: true });
  });

  it("does not reject lowercase words that merely contain the operator letters", () => {
    expect(v("minor cannot reproduce")).toMatchObject({ ok: true });
  });
});
