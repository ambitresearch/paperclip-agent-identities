import { describe, it, expect, vi } from "vitest";
import { githubAddIssueCommentToolSpec } from "../../../src/providers/github/tools/add-issue-comment.js";
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

describe("githubAddIssueCommentToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubAddIssueCommentToolSpec.validateParams({ issueNumber: 1, body: "hi" })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid issueNumber", () => {
    expect(
      githubAddIssueCommentToolSpec.validateParams({ repository: "acme/widgets", body: "hi" })
    ).toEqual({ ok: false, error: "issueNumber must be a positive integer" });
  });

  it("rejects a missing body", () => {
    expect(
      githubAddIssueCommentToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 1 })
    ).toEqual({ ok: false, error: "body is required" });
  });

  it("accepts valid params", () => {
    const res = githubAddIssueCommentToolSpec.validateParams({
      repository: "acme/widgets", issueNumber: 1, body: "hi there"
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a non-string llmModel", () => {
    expect(
      githubAddIssueCommentToolSpec.validateParams({
        repository: "acme/widgets", issueNumber: 1, body: "hi", llmModel: 5
      })
    ).toEqual({ ok: false, error: "llmModel must be a string if provided" });
  });
});

describe("githubAddIssueCommentToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubAddIssueCommentToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", issueNumber: 1, body: "hi" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository", async () => {
    const res = await githubAddIssueCommentToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", issueNumber: 1, body: "hi" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubAddIssueCommentToolSpec.perform", () => {
  function execution(token: string | null, body = "hi there"): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      tokenSource: "github-app",
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", issueNumber: 7, body },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubAddIssueCommentToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("posts the comment with an appended AI-authorship footer", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.body).toContain("hi there");
      expect(body.body).toContain("posted by an AI agent via Paperclip");
      return new Response(
        JSON.stringify({ id: 42, html_url: "https://github.com/acme/widgets/issues/7#issuecomment-42", body: body.body }),
        { status: 201 }
      );
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubAddIssueCommentToolSpec.perform(exec)) as { content: string; data: { id: number } };
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect(result.data.id).toBe(42);
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ id: 5, html_url: "https://github.com/acme/widgets/issues/7#issuecomment-5", body: "" }),
      { status: 201 }
    ));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubAddIssueCommentToolSpec.perform(exec);
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
    const result = (await githubAddIssueCommentToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ message: "Issue is locked" }),
      { status: 422 }
    ));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubAddIssueCommentToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("422");
    expect(result.error).toContain("Issue is locked");
  });
});
