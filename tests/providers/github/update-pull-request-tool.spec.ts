import { describe, it, expect, vi } from "vitest";
import { githubUpdatePullRequestToolSpec } from "../../../src/providers/github/tools/update-pull-request.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type {
  ProviderToolExecution
} from "../../../src/core/provider-contract.js";
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

describe("githubUpdatePullRequestToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(githubUpdatePullRequestToolSpec.validateParams({ pullNumber: 1, title: "t" }))
      .toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid pullNumber", () => {
    expect(githubUpdatePullRequestToolSpec.validateParams({ repository: "acme/widgets", title: "t" }))
      .toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("rejects an invalid state", () => {
    expect(githubUpdatePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, state: "merged" }))
      .toEqual({ ok: false, error: 'state must be "open" or "closed" if provided' });
  });

  it("requires at least one updatable field", () => {
    expect(githubUpdatePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1 }))
      .toEqual({ ok: false, error: "at least one of title, body, base, state, draft must be provided" });
  });

  it("accepts a full valid param set", () => {
    const res = githubUpdatePullRequestToolSpec.validateParams({
      repository: "acme/widgets", pullNumber: 1, title: "New title", body: "New body",
      base: "develop", state: "closed", draft: true, llmModel: "claude"
    });
    expect(res.ok).toBe(true);
  });
});

describe("githubUpdatePullRequestToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubUpdatePullRequestToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 1, title: "t" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository", async () => {
    const res = await githubUpdatePullRequestToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", pullNumber: 1, title: "t" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubUpdatePullRequestToolSpec.perform", () => {
  function execution(
    token: string | null,
    params: Record<string, unknown>
  ): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", pullNumber: 42, ...params },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  function prResponse(overrides: Record<string, unknown> = {}) {
    return {
      number: 42,
      html_url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      draft: false,
      title: "My PR",
      node_id: "PR_kwabc",
      head: { ref: "feature" },
      base: { ref: "main" },
      ...overrides
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubUpdatePullRequestToolSpec.perform(execution(null, { title: "t" }))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("PATCHes title/body/base/state and appends the AI-authorship footer to a non-empty body", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify(prResponse()), { status: 200 });
    });
    const exec = execution("tok", { title: "New title", body: "New body", base: "develop", state: "closed", llmModel: "claude-x" });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubUpdatePullRequestToolSpec.perform(exec)) as { content: string; data: { number: number } };

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls/42");
    expect(init.method).toBe("PATCH");
    expect(capturedBody).toMatchObject({ title: "New title", base: "develop", state: "closed" });
    expect((capturedBody as { body: string }).body).toContain("New body");
    expect((capturedBody as { body: string }).body).toContain("posted by an AI agent via Paperclip");
    expect((capturedBody as { body: string }).body).toContain("claude-x");
    expect(result.data.number).toBe(42);
  });

  it("does not append a footer when body is not provided", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify(prResponse()), { status: 200 });
    });
    const exec = execution("tok", { title: "Only title" });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    await githubUpdatePullRequestToolSpec.perform(exec);
    expect(capturedBody).toEqual({ title: "Only title" });
  });

  it("does not include a `draft` field in the REST PATCH body (GitHub REST rejects it)", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://api.github.com/graphql") {
        return new Response(JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { id: "PR_kwabc" } } } }), { status: 200 });
      }
      capturedBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify(prResponse({ draft: true })), { status: 200 });
    });
    const exec = execution("tok", { draft: true });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    await githubUpdatePullRequestToolSpec.perform(exec);
    expect(capturedBody).toEqual({});
  });

  it("toggles draft state via a GraphQL mutation keyed by node_id when draft changes", async () => {
    let graphqlBody: unknown;
    let restCallCount = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://api.github.com/graphql") {
        graphqlBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_kwabc" } } } }), { status: 200 });
      }
      restCallCount += 1;
      // first PATCH returns the pre-toggle draft:true PR, then the
      // post-toggle GET refetch returns draft:false.
      return new Response(JSON.stringify(prResponse({ draft: restCallCount === 1 })), { status: 200 });
    });
    const exec = execution("tok", { draft: false });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubUpdatePullRequestToolSpec.perform(exec)) as { data: { draft: boolean } };

    expect(graphqlBody).toMatchObject({ variables: { id: "PR_kwabc" } });
    expect((graphqlBody as { query: string }).query).toContain("markPullRequestReadyForReview");
    expect(result.data.draft).toBe(false);
  });

  it("skips the draft mutation when the requested draft state already matches", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(prResponse({ draft: true })), { status: 200 }));
    const exec = execution("tok", { draft: true });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    await githubUpdatePullRequestToolSpec.perform(exec);
    // Only the initial PATCH call — no GraphQL mutation, no refetch.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the GitHub PATCH API responds with a failure status", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 }));
    const exec = execution("tok", { title: "t" });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubUpdatePullRequestToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("422");
    expect(result.error).toContain("Validation Failed");
  });

  it("returns an error when the draft-toggle GraphQL mutation fails", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://api.github.com/graphql") {
        return new Response(JSON.stringify({ errors: [{ message: "not authorized" }] }), { status: 200 });
      }
      return new Response(JSON.stringify(prResponse({ draft: false })), { status: 200 });
    });
    const exec = execution("tok", { draft: true });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubUpdatePullRequestToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("not authorized");
  });

  it("awaits the activity audit write before returning success", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(prResponse()), { status: 200 }));
    let finishLog: (() => void) | undefined;
    const activityLog = vi.fn(() => new Promise<void>((resolve) => { finishLog = resolve; }));
    const exec = execution("tok", { title: "t" });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    let settled = false;
    const result = githubUpdatePullRequestToolSpec.perform(exec).then(() => { settled = true; });
    await vi.waitFor(() => expect(activityLog).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishLog?.();
    await result;
  });
});
