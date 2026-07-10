import { describe, it, expect, vi } from "vitest";
import { githubCreatePullRequestToolSpec } from "../../../src/providers/github/tools/create-pull-request.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type {
  ProviderToolExecution
} from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

function repoRef(): GitHubRepoRef {
  return { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" };
}

function buildCtx(fetchImpl: typeof fetch) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: vi.fn() }
  } as never;
}

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

  it("posts to the GitHub PR API and returns the created PR", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 42, html_url: "https://github.com/acme/widgets/pull/42", state: "open", draft: false, head: { ref: "feature" }, base: { ref: "main" } }),
      { status: 201 }
    ));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubCreatePullRequestToolSpec.perform(exec)) as { content: string; data: { number: number } };
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(result.data.number).toBe(42);
    expect(result.content).toContain("#42");
  });
});
