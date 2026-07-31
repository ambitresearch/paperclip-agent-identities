import { describe, it, expect, vi } from "vitest";
import {
  evaluateMergeGate,
  githubMergePullRequestToolSpec,
  REQUIRED_NON_AUTHOR_APPROVALS,
  type MergeGateInput
} from "../../../src/providers/github/tools/merge-pull-request.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "reviewer-bot" } };

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);

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

/** A gate input that passes every condition; tests override one field at a time. */
function passingGate(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    callerLogin: "reviewer-bot",
    authorLogin: "author-bot",
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeableState: "clean",
    headSha: HEAD,
    reviews: [
      { login: "reviewer-bot", state: "APPROVED", commitId: HEAD },
      { login: "other-bot", state: "APPROVED", commitId: HEAD }
    ],
    unresolvedThreadCount: 0,
    checksState: "success",
    checkSignalCount: 3,
    ...overrides
  };
}

function codes(input: MergeGateInput): string[] {
  return evaluateMergeGate(input).blockers.map((blocker) => blocker.code);
}

describe("evaluateMergeGate", () => {
  it("passes a fully clean pull request", () => {
    const result = evaluateMergeGate(passingGate());
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.approvers).toEqual(["reviewer-bot", "other-bot"]);
  });

  it("requires two distinct non-author approvals", () => {
    expect(REQUIRED_NON_AUTHOR_APPROVALS).toBe(2);
    expect(
      codes(passingGate({ reviews: [{ login: "other-bot", state: "APPROVED", commitId: HEAD }] }))
    ).toContain("insufficient_approvals");
  });

  it("counts only a reviewer's latest decision, so one reviewer cannot approve twice", () => {
    const result = evaluateMergeGate(
      passingGate({
        reviews: [
          { login: "other-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "APPROVED", commitId: HEAD }
        ]
      })
    );
    expect(result.approvers).toEqual(["other-bot"]);
    expect(result.blockers.map((b) => b.code)).toContain("insufficient_approvals");
  });

  it("discards an approval superseded by that reviewer's later CHANGES_REQUESTED", () => {
    const result = evaluateMergeGate(
      passingGate({
        reviews: [
          { login: "reviewer-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "CHANGES_REQUESTED", commitId: HEAD }
        ]
      })
    );
    expect(result.changesRequestedBy).toEqual(["other-bot"]);
    expect(result.blockers.map((b) => b.code)).toEqual(
      expect.arrayContaining(["changes_requested", "insufficient_approvals"])
    );
  });

  it("restores an approval when a later review re-approves", () => {
    const result = evaluateMergeGate(
      passingGate({
        reviews: [
          { login: "reviewer-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "CHANGES_REQUESTED", commitId: HEAD },
          { login: "other-bot", state: "APPROVED", commitId: HEAD }
        ]
      })
    );
    expect(result.ok).toBe(true);
  });

  it("ignores COMMENT reviews entirely", () => {
    const result = evaluateMergeGate(
      passingGate({
        reviews: [
          { login: "reviewer-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "COMMENTED", commitId: HEAD }
        ]
      })
    );
    expect(result.ok).toBe(true);
  });

  it("treats a DISMISSED review as no longer approving", () => {
    const result = evaluateMergeGate(
      passingGate({
        reviews: [
          { login: "reviewer-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "DISMISSED", commitId: HEAD }
        ]
      })
    );
    expect(result.approvers).toEqual(["reviewer-bot"]);
    expect(result.blockers.map((b) => b.code)).toContain("insufficient_approvals");
  });

  it("does not count approvals submitted against an earlier commit", () => {
    const result = evaluateMergeGate(
      passingGate({
        reviews: [
          { login: "reviewer-bot", state: "APPROVED", commitId: OLD_HEAD },
          { login: "other-bot", state: "APPROVED", commitId: HEAD }
        ]
      })
    );
    expect(result.staleApprovers).toEqual(["reviewer-bot"]);
    expect(result.approvers).toEqual(["other-bot"]);
    const blocker = result.blockers.find((b) => b.code === "insufficient_approvals");
    expect(blocker?.message).toContain("predate the current head");
  });

  it("does not count the author's own approval toward the requirement", () => {
    const result = evaluateMergeGate(
      passingGate({
        reviews: [
          { login: "author-bot", state: "APPROVED", commitId: HEAD },
          { login: "other-bot", state: "APPROVED", commitId: HEAD }
        ]
      })
    );
    expect(result.approvers).toEqual(["other-bot"]);
    expect(result.blockers.map((b) => b.code)).toContain("insufficient_approvals");
  });

  it("refuses when the caller authored the pull request", () => {
    expect(codes(passingGate({ callerLogin: "author-bot" }))).toContain("caller_is_author");
  });

  it("matches caller and author across the [bot] login suffix", () => {
    expect(
      codes(passingGate({ callerLogin: "author-bot[bot]", authorLogin: "author-bot" }))
    ).toContain("caller_is_author");
  });

  it("refuses a draft, a closed, and an already-merged pull request", () => {
    expect(codes(passingGate({ draft: true }))).toContain("draft");
    expect(codes(passingGate({ state: "closed" }))).toContain("not_open");
    expect(codes(passingGate({ merged: true, state: "closed" }))).toEqual(["not_open"]);
  });

  it("refuses while GitHub is still computing mergeability", () => {
    expect(codes(passingGate({ mergeable: null, mergeableState: "unknown" }))).toContain("not_mergeable");
  });

  it("refuses conflicting, behind, and branch-protection-blocked pull requests", () => {
    expect(codes(passingGate({ mergeable: false, mergeableState: "dirty" }))).toContain("not_mergeable");
    expect(codes(passingGate({ mergeableState: "behind" }))).toContain("not_mergeable");
    expect(codes(passingGate({ mergeableState: "blocked" }))).toContain("not_mergeable");
  });

  it("refuses on unresolved review threads", () => {
    const result = evaluateMergeGate(passingGate({ unresolvedThreadCount: 2 }));
    expect(result.blockers.map((b) => b.code)).toContain("unresolved_review_threads");
    expect(result.blockers.find((b) => b.code === "unresolved_review_threads")?.message).toContain("2");
  });

  it("refuses on failing and on still-running checks", () => {
    expect(codes(passingGate({ checksState: "failure" }))).toContain("checks_not_passing");
    expect(codes(passingGate({ checksState: "pending" }))).toContain("checks_not_passing");
  });

  it("does not block when the repository reported no check signals at all", () => {
    // Nothing is pending because nothing is configured. The caller is told via
    // `checksState: "none"` rather than being shown an unearned green light.
    const result = evaluateMergeGate(passingGate({ checksState: "pending", checkSignalCount: 0 }));
    expect(result.ok).toBe(true);
  });

  it("refuses when expectedHeadSha no longer matches the current head", () => {
    expect(codes(passingGate({ expectedHeadSha: OLD_HEAD }))).toContain("head_sha_mismatch");
    expect(evaluateMergeGate(passingGate({ expectedHeadSha: HEAD })).ok).toBe(true);
  });

  it("reports every blocker at once rather than short-circuiting on the first", () => {
    const result = evaluateMergeGate(
      passingGate({
        draft: true,
        unresolvedThreadCount: 1,
        checksState: "failure",
        reviews: []
      })
    );
    expect(result.blockers.map((b) => b.code).sort()).toEqual(
      ["checks_not_passing", "draft", "insufficient_approvals", "unresolved_review_threads"].sort()
    );
  });
});

describe("githubMergePullRequestToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(githubMergePullRequestToolSpec.validateParams({ pullNumber: 1 })).toEqual({
      ok: false,
      error: 'repository is required (e.g. "my-org/my-repo")'
    });
  });

  it("rejects a missing/invalid pullNumber", () => {
    expect(githubMergePullRequestToolSpec.validateParams({ repository: "acme/widgets" })).toEqual({
      ok: false,
      error: "pullNumber must be a positive integer"
    });
  });

  it("defaults mergeMethod to squash", () => {
    const res = githubMergePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7 });
    expect(res).toEqual({ ok: true, params: expect.objectContaining({ mergeMethod: "squash" }) });
  });

  it("accepts each supported merge method and rejects anything else", () => {
    for (const mergeMethod of ["merge", "squash", "rebase"]) {
      const res = githubMergePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7, mergeMethod });
      expect(res.ok).toBe(true);
    }
    expect(
      githubMergePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7, mergeMethod: "fast-forward" })
    ).toEqual({ ok: false, error: 'mergeMethod must be one of "merge", "squash", "rebase" if provided' });
  });

  it("rejects a short or non-hex expectedHeadSha", () => {
    expect(
      githubMergePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7, expectedHeadSha: "abc1234" })
    ).toEqual({ ok: false, error: "expectedHeadSha must be a full 40-character hex commit SHA if provided" });
    expect(
      githubMergePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7, expectedHeadSha: HEAD })
    ).toMatchObject({ ok: true });
  });

  it("rejects a non-string paperclipIssueId", () => {
    expect(
      githubMergePullRequestToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 7, paperclipIssueId: 123 })
    ).toEqual({ ok: false, error: "paperclipIssueId must be a string if provided" });
  });
});

describe("githubMergePullRequestToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubMergePullRequestToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 7 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository before any credential is resolved", async () => {
    const res = await githubMergePullRequestToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", pullNumber: 7 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

/* ------------------------------------------------------------------ */
/* perform() — a routable fake GitHub                                  */
/* ------------------------------------------------------------------ */

interface FakeGitHubOptions {
  pr?: Record<string, unknown>;
  reviews?: Array<{ user: { login: string } | null; state: string; commit_id: string | null }>;
  threads?: Array<{ isResolved: boolean }>;
  /** Forces `hasNextPage` on every thread page so the cap can be exhausted. */
  threadsAlwaysHaveNextPage?: boolean;
  checkRuns?: Array<{ status: string; conclusion: string | null }>;
  /** Overrides `total_count` so a truncated page — GitHub's real failure mode — is representable. */
  checkRunsTotalCount?: number;
  workflowRuns?: Array<{ id?: number; workflow_id?: number; status: string; conclusion: string | null }>;
  workflowRunsTotalCount?: number;
  mergeResponse?: Response;
}

function fakeGitHub(options: FakeGitHubOptions = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const pr = {
    state: "open",
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: "clean",
    title: "Add a thing",
    user: { login: "author-bot" },
    head: { sha: HEAD },
    base: { ref: "main" },
    ...(options.pr ?? {})
  };
  const reviews = options.reviews ?? [
    { user: { login: "reviewer-bot" }, state: "APPROVED", commit_id: HEAD },
    { user: { login: "other-bot" }, state: "APPROVED", commit_id: HEAD }
  ];
  const threads = options.threads ?? [{ isResolved: true }];
  const checkRuns = options.checkRuns ?? [{ status: "completed", conclusion: "success" }];
  const workflowRuns = options.workflowRuns ?? [];

  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === "https://api.github.com/graphql") {
      return json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: {
                  hasNextPage: options.threadsAlwaysHaveNextPage === true,
                  endCursor: options.threadsAlwaysHaveNextPage === true ? "cursor" : null
                },
                nodes: threads
              }
            }
          }
        }
      });
    }
    if (url.includes("/pulls/7/merge")) {
      return options.mergeResponse ?? json({ sha: "c".repeat(40), merged: true, message: "Pull Request successfully merged" });
    }
    if (url.includes("/pulls/7/reviews")) return json(reviews);
    if (url.endsWith("/pulls/7")) return json(pr);
    if (url.includes("/check-runs")) {
      return json({ total_count: options.checkRunsTotalCount ?? checkRuns.length, check_runs: checkRuns });
    }
    if (url.includes("/status")) return json({ state: "pending", statuses: [] });
    if (url.includes("/actions/runs")) {
      return json({ total_count: options.workflowRunsTotalCount ?? workflowRuns.length, workflow_runs: workflowRuns });
    }
    throw new Error(`unexpected url ${url}`);
  });

  return { fetchImpl, calls };
}

function execution(
  token: string | null,
  ctx: unknown,
  params: Record<string, unknown> = {}
): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
  return {
    token,
    identity,
    resourceRef: repoRef(),
    params: { repository: "acme/widgets", pullNumber: 7, mergeMethod: "squash", ...params },
    ctx,
    runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" }
  } as never;
}

describe("githubMergePullRequestToolSpec.perform", () => {
  it("fails closed when the resolved token is null (identity verified, no secret minted)", async () => {
    const result = (await githubMergePullRequestToolSpec.perform(
      execution(null, buildCtx(vi.fn() as never))
    )) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("merges a clean pull request and pins the observed head SHA on the merge call", async () => {
    const { fetchImpl } = fakeGitHub();
    const activityLog = vi.fn(async () => {});
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never, activityLog))
    )) as { content: string; data: { merged: boolean; mergeCommitSha: string; approvers: string[] } };

    const mergeCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("/merge")) as [string, RequestInit];
    expect(mergeCall[0]).toBe("https://api.github.com/repos/acme/widgets/pulls/7/merge");
    expect(mergeCall[1].method).toBe("PUT");
    expect((mergeCall[1].headers as Record<string, string>)["Authorization"]).toBe("Bearer tok");
    const body = JSON.parse(mergeCall[1].body as string);
    expect(body).toEqual({ merge_method: "squash", sha: HEAD });

    expect(result.data.merged).toBe(true);
    expect(result.data.approvers).toEqual(["reviewer-bot", "other-bot"]);
    expect(result.content).toContain("Merged PR #7");
    expect(activityLog).toHaveBeenCalledOnce();
  });

  it("forwards an explicit merge method and commit title/body", async () => {
    const { fetchImpl } = fakeGitHub();
    await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never), {
        mergeMethod: "merge",
        commitTitle: "Custom title",
        commitBody: "Custom body"
      })
    );
    const mergeCall = fetchImpl.mock.calls.find(([url]) => String(url).includes("/merge")) as [string, RequestInit];
    expect(JSON.parse(mergeCall[1].body as string)).toEqual({
      merge_method: "merge",
      sha: HEAD,
      commit_title: "Custom title",
      commit_message: "Custom body"
    });
  });

  it("never calls the merge endpoint when the gate refuses", async () => {
    const { fetchImpl } = fakeGitHub({ threads: [{ isResolved: false }, { isResolved: false }] });
    const activityLog = vi.fn(async () => {});
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never, activityLog))
    )) as { error: string; data: { merged: boolean; blockers: Array<{ code: string }> } };

    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(result.data.merged).toBe(false);
    expect(result.data.blockers.map((b) => b.code)).toEqual(["unresolved_review_threads"]);
    expect(result.error).toContain("2 review thread(s) are still unresolved");
    expect(activityLog).not.toHaveBeenCalled();
  });

  it("asks GitHub for the maximum page size on both paginated check endpoints", async () => {
    const { fetchImpl } = fakeGitHub();
    await githubMergePullRequestToolSpec.perform(execution("tok", buildCtx(fetchImpl as never)));
    const urls = fetchImpl.mock.calls.map(([url]) => String(url));
    expect(urls).toContain(`https://api.github.com/repos/acme/widgets/commits/${HEAD}/check-runs?per_page=100`);
    expect(urls).toContain(`https://api.github.com/repos/acme/widgets/actions/runs?head_sha=${HEAD}&per_page=100`);
  });

  it("refuses rather than merging when check runs did not fit on one page", async () => {
    // 100 green runs read, but GitHub says there are 142. The red one could be
    // any of the 42 never returned, so the gate must not judge from this slice.
    const { fetchImpl } = fakeGitHub({
      checkRuns: Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" })),
      checkRunsTotalCount: 142
    });
    const activityLog = vi.fn(async () => {});
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never, activityLog))
    )) as { error: string };

    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(activityLog).not.toHaveBeenCalled();
    expect(result.error).toContain("check runs (read 100 of 142)");
    expect(result.error).toContain("Refusing to judge the merge gate from a partial read");
  });

  it("refuses rather than merging when workflow runs did not fit on one page", async () => {
    const { fetchImpl } = fakeGitHub({
      workflowRuns: Array.from({ length: 100 }, () => ({ status: "completed", conclusion: "success" })),
      workflowRunsTotalCount: 101
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(result.error).toContain("workflow runs (read 100 of 101)");
  });

  it("merges normally when total_count matches what the page carried", async () => {
    const { fetchImpl } = fakeGitHub({
      checkRuns: Array.from({ length: 42 }, () => ({ status: "completed", conclusion: "success" })),
      checkRunsTotalCount: 42
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { data: { merged: boolean } };
    expect(result.data.merged).toBe(true);
  });

  it("refuses rather than merging when the review history runs past the page cap", async () => {
    // Every page comes back full, so the loop exhausts its cap with reviews
    // still unread. A blocking CHANGES_REQUESTED could be sitting in the tail.
    const { fetchImpl } = fakeGitHub({
      reviews: Array.from({ length: 100 }, () => ({
        user: { login: "other-bot" },
        state: "APPROVED",
        commit_id: HEAD
      }))
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(result.error).toContain("more than 1000 reviews");
    expect(result.error).toContain("Refusing to judge approvals from a partial read");
  });

  it("refuses rather than merging when review threads run past the page cap", async () => {
    // Resolved threads on every page, but `hasNextPage` never clears — the
    // unread tail is exactly where an unresolved thread would hide.
    const { fetchImpl } = fakeGitHub({
      threads: [{ isResolved: true }],
      threadsAlwaysHaveNextPage: true
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(result.error).toContain("more than 1000 review threads");
    expect(result.error).toContain("Refusing to judge thread resolution from a partial read");
  });

  it("merges past a cancelled run that a later run of the same workflow displaced", async () => {
    // The `concurrency: cancel-in-progress` artifact: run 1 lost the race to
    // run 2. Nothing ever rewrites it, so treating it as fatal would pin the
    // pull request at checks_not_passing permanently.
    const { fetchImpl } = fakeGitHub({
      workflowRuns: [
        { id: 1, workflow_id: 99, status: "completed", conclusion: "cancelled" },
        { id: 2, workflow_id: 99, status: "completed", conclusion: "success" }
      ]
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never, vi.fn(async () => {})))
    )) as { data: { merged: boolean; checksState: string } };
    expect(result.data.merged).toBe(true);
    expect(result.data.checksState).toBe("success");
  });

  it("still refuses when the cancelled run is the newest for its workflow", async () => {
    // Nothing displaced it, so somebody cancelled this deliberately.
    const { fetchImpl } = fakeGitHub({
      workflowRuns: [
        { id: 1, workflow_id: 99, status: "completed", conclusion: "success" },
        { id: 2, workflow_id: 99, status: "completed", conclusion: "cancelled" }
      ]
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(result.error).toContain("Checks are failing");
  });

  it("refuses to merge a pull request the caller authored", async () => {
    const { fetchImpl } = fakeGitHub({ pr: { user: { login: "reviewer-bot" } } });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(result.error).toContain("merge must be performed by a different agent identity");
  });

  it("refuses when the reviewed head has been overwritten by a later push", async () => {
    const { fetchImpl } = fakeGitHub();
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never), { expectedHeadSha: OLD_HEAD })
    )) as { error: string };
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes("/merge"))).toBe(false);
    expect(result.error).toContain("The branch moved after it was reviewed");
  });

  it("explains a 409 from GitHub as a head that moved under the gate", async () => {
    const { fetchImpl } = fakeGitHub({
      mergeResponse: new Response(JSON.stringify({ message: "Head branch was modified. Review and try the merge again." }), { status: 409 })
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(result.error).toContain("409");
    expect(result.error).toContain("Head branch was modified");
    expect(result.error).toContain("moved after the merge gate passed");
  });

  it("logs activity metadata without ever including the token", async () => {
    const { fetchImpl } = fakeGitHub();
    const activityLog = vi.fn(async () => {});
    await githubMergePullRequestToolSpec.perform(
      execution("super-secret-token", buildCtx(fetchImpl as never, activityLog))
    );
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("super-secret-token", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK pull request read", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const result = (await githubMergePullRequestToolSpec.perform(
      execution("tok", buildCtx(fetchImpl as never))
    )) as { error: string };
    expect(result.error).toContain("404");
    expect(result.error).toContain("Not Found");
  });
});
