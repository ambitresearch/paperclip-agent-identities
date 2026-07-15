import { describe, it, expect, vi } from "vitest";
import { githubSubmitPullRequestReviewToolSpec } from "../../../src/providers/github/tools/submit-pull-request-review.js";
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

describe("githubSubmitPullRequestReviewToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubSubmitPullRequestReviewToolSpec.validateParams({ pullNumber: 1, event: "APPROVE", body: "lgtm" })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid pullNumber", () => {
    expect(
      githubSubmitPullRequestReviewToolSpec.validateParams({ repository: "acme/widgets", event: "APPROVE", body: "lgtm" })
    ).toEqual({ ok: false, error: "pullNumber must be a positive integer" });

    expect(
      githubSubmitPullRequestReviewToolSpec.validateParams({
        repository: "acme/widgets", pullNumber: -1, event: "APPROVE", body: "lgtm"
      })
    ).toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("rejects an invalid event", () => {
    expect(
      githubSubmitPullRequestReviewToolSpec.validateParams({
        repository: "acme/widgets", pullNumber: 1, event: "MERGE", body: "lgtm"
      })
    ).toEqual({ ok: false, error: 'event must be one of "APPROVE", "REQUEST_CHANGES", "COMMENT"' });
  });

  it("accepts each supported event", () => {
    for (const event of ["APPROVE", "REQUEST_CHANGES", "COMMENT"]) {
      const res = githubSubmitPullRequestReviewToolSpec.validateParams({
        repository: "acme/widgets", pullNumber: 1, event, body: "review body"
      });
      expect(res.ok).toBe(true);
    }
  });

  it("requires a body when no inline comments are provided", () => {
    expect(
      githubSubmitPullRequestReviewToolSpec.validateParams({
        repository: "acme/widgets", pullNumber: 1, event: "APPROVE"
      })
    ).toEqual({ ok: false, error: "body is required when no inline comments are provided" });
  });

  it("accepts inline comments in lieu of a body", () => {
    const res = githubSubmitPullRequestReviewToolSpec.validateParams({
      repository: "acme/widgets",
      pullNumber: 1,
      event: "REQUEST_CHANGES",
      comments: [{ path: "src/index.ts", line: 10, body: "Fix this" }]
    });
    expect(res.ok).toBe(true);
  });

  it("rejects a malformed inline comment", () => {
    expect(
      githubSubmitPullRequestReviewToolSpec.validateParams({
        repository: "acme/widgets",
        pullNumber: 1,
        event: "COMMENT",
        comments: [{ path: "src/index.ts", line: 0, body: "Fix this" }]
      })
    ).toEqual({ ok: false, error: "comments[0].line must be a positive integer" });
  });

  it("rejects a non-string paperclipIssueId", () => {
    expect(
      githubSubmitPullRequestReviewToolSpec.validateParams({
        repository: "acme/widgets", pullNumber: 1, event: "APPROVE", body: "lgtm", paperclipIssueId: 123
      })
    ).toEqual({ ok: false, error: "paperclipIssueId must be a string if provided" });
  });
});

describe("githubSubmitPullRequestReviewToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubSubmitPullRequestReviewToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 1, event: "APPROVE", body: "lgtm" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository before any credential is resolved", async () => {
    const res = await githubSubmitPullRequestReviewToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", pullNumber: 1, event: "APPROVE", body: "lgtm" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubSubmitPullRequestReviewToolSpec.perform", () => {
  function execution(
    token: string | null,
    overrides: Partial<{ event: string; body?: string; comments?: unknown[] }> = {}
  ): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: {
        repository: "acme/widgets",
        pullNumber: 7,
        event: overrides.event ?? "APPROVE",
        body: overrides.body ?? "Looks good",
        comments: overrides.comments
      },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null (identity verified, no secret minted)", async () => {
    const result = (await githubSubmitPullRequestReviewToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("posts APPROVE to the GitHub reviews API and returns the created review", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.event).toBe("APPROVE");
      return new Response(
        JSON.stringify({ id: 99, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-99", state: "APPROVED", body: "Looks good" }),
        { status: 200 }
      );
    });
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubSubmitPullRequestReviewToolSpec.perform(exec)) as { content: string; data: { id: number } };
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/pulls/7/reviews");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    expect(result.data.id).toBe(99);
    expect(result.content).toContain("APPROVE");
  });

  it("submits REQUEST_CHANGES with inline comments", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.event).toBe("REQUEST_CHANGES");
      expect(body.comments).toEqual([{ path: "src/index.ts", line: 10, body: "Fix this" }]);
      return new Response(
        JSON.stringify({ id: 100, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-100", state: "CHANGES_REQUESTED", body: "" }),
        { status: 200 }
      );
    });
    const exec = execution("tok", {
      event: "REQUEST_CHANGES",
      body: undefined,
      comments: [{ path: "src/index.ts", line: 10, body: "Fix this" }]
    });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubSubmitPullRequestReviewToolSpec.perform(exec)) as { data: { event: string } };
    expect(result.data.event).toBe("REQUEST_CHANGES");
  });

  it("awaits the activity audit write before returning success", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ id: 1, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1", state: "APPROVED", body: "" }),
      { status: 200 }
    ));
    let finishLog: (() => void) | undefined;
    const activityLog = vi.fn(() => new Promise<void>((resolve) => { finishLog = resolve; }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    let settled = false;
    const result = githubSubmitPullRequestReviewToolSpec.perform(exec).then(() => { settled = true; });
    await vi.waitFor(() => expect(activityLog).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishLog?.();
    await result;
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ id: 5, html_url: "https://github.com/acme/widgets/pull/7#pullrequestreview-5", state: "APPROVED", body: "" }),
      { status: 200 }
    ));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubSubmitPullRequestReviewToolSpec.perform(exec);
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
    const result = (await githubSubmitPullRequestReviewToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ message: "Review cannot be submitted on your own pull request" }),
      { status: 422 }
    ));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubSubmitPullRequestReviewToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("422");
    expect(result.error).toContain("Review cannot be submitted on your own pull request");
  });
});
