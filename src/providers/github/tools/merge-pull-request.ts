import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import type { GitHubRepoRef } from "../repo-ref.js";
import { normalizeGitHubRepoRef } from "../repo-ref.js";
import { executeGitHubGraphQL, type GitHubGraphQLFailure, type GitHubGraphQLResult } from "../graphql.js";
import { CHECK_RUNS_PER_PAGE, computeAggregateState, describeTruncatedRead, dropSupersededWorkflowRuns } from "./get-pull-request-checks.js";
import {
  githubBotMergePullRequestToolMetadata,
  githubBotMergePullRequestToolName
} from "../../../shared/github-bot-merge-pull-request-tool.js";

export type MergeMethod = "merge" | "squash" | "rebase";

const VALID_MERGE_METHODS: readonly MergeMethod[] = ["merge", "squash", "rebase"];

/**
 * Approving reviews required from distinct reviewers who are not the pull
 * request author. Deliberately a constant rather than a parameter: a caller
 * able to pass `requiredApprovals: 0` would turn the gate into a no-op, which
 * is exactly the self-discipline this wrapper exists to replace.
 */
export const REQUIRED_NON_AUTHOR_APPROVALS = 2;

/**
 * `mergeable_state` values the gate will proceed on. `clean` is the happy path;
 * `has_hooks` is clean plus repo pre-receive hooks; `unstable` means only
 * non-required checks are red, which the independent checks gate below judges
 * on its own. Everything else (`dirty` conflicts, `behind` out-of-date branch,
 * `blocked` unmet branch protection, `unknown` still-computing) fails closed.
 */
const MERGEABLE_STATES = new Set(["clean", "has_hooks", "unstable"]);

export interface MergePullRequestParams {
  repository: string;
  pullNumber: number;
  mergeMethod: MergeMethod;
  commitTitle?: string;
  commitBody?: string;
  expectedHeadSha?: string;
  paperclipIssueId?: string;
}

const FULL_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.repository || typeof p.repository !== "string") {
    return { ok: false, error: 'repository is required (e.g. "my-org/my-repo")' };
  }
  if (typeof p.pullNumber !== "number" || !Number.isInteger(p.pullNumber) || p.pullNumber <= 0) {
    return { ok: false, error: "pullNumber must be a positive integer" };
  }
  if (p.mergeMethod !== undefined && (typeof p.mergeMethod !== "string" || !VALID_MERGE_METHODS.includes(p.mergeMethod as MergeMethod))) {
    return { ok: false, error: 'mergeMethod must be one of "merge", "squash", "rebase" if provided' };
  }
  if (p.commitTitle !== undefined && typeof p.commitTitle !== "string") {
    return { ok: false, error: "commitTitle must be a string if provided" };
  }
  if (p.commitBody !== undefined && typeof p.commitBody !== "string") {
    return { ok: false, error: "commitBody must be a string if provided" };
  }
  if (p.expectedHeadSha !== undefined) {
    if (typeof p.expectedHeadSha !== "string" || !FULL_SHA_PATTERN.test(p.expectedHeadSha)) {
      return { ok: false, error: "expectedHeadSha must be a full 40-character hex commit SHA if provided" };
    }
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }

  const validated: MergePullRequestParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    mergeMethod: (p.mergeMethod as MergeMethod | undefined) ?? "squash",
    commitTitle: p.commitTitle as string | undefined,
    commitBody: p.commitBody as string | undefined,
    expectedHeadSha: p.expectedHeadSha as string | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

/* ------------------------------------------------------------------ */
/* Merge gate                                                          */
/* ------------------------------------------------------------------ */

export type MergeGateBlockerCode =
  | "not_open"
  | "draft"
  | "caller_is_author"
  | "head_sha_mismatch"
  | "not_mergeable"
  | "changes_requested"
  | "insufficient_approvals"
  | "unresolved_review_threads"
  | "checks_not_passing";

export interface MergeGateBlocker {
  code: MergeGateBlockerCode;
  message: string;
}

export interface MergeGateReview {
  login: string | null;
  state: string;
  commitId: string | null;
}

export interface MergeGateInput {
  callerLogin: string;
  authorLogin: string | null;
  state: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
  expectedHeadSha?: string;
  reviews: MergeGateReview[];
  unresolvedThreadCount: number;
  checksState: "success" | "failure" | "pending";
  checkSignalCount: number;
}

export interface MergeGateResult {
  ok: boolean;
  blockers: MergeGateBlocker[];
  approvers: string[];
  staleApprovers: string[];
  changesRequestedBy: string[];
}

/**
 * GitHub reports App identities as `name[bot]` in some payloads and `name` in
 * others. Compare on the stripped, case-folded form so a stored username
 * without the suffix still matches the author login GitHub returns.
 */
function normalizeLogin(login: string | null | undefined): string {
  if (!login) return "";
  return login.trim().toLowerCase().replace(/\[bot\]$/, "");
}

/**
 * Decide whether a pull request may be merged, collecting *every* reason it may
 * not rather than short-circuiting on the first — an agent that has to fix
 * three things should learn all three from one call.
 *
 * Pure and exported so the gate is unit-testable without any HTTP.
 */
export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const blockers: MergeGateBlocker[] = [];
  const caller = normalizeLogin(input.callerLogin);
  const author = normalizeLogin(input.authorLogin);

  if (input.merged) {
    blockers.push({ code: "not_open", message: "Pull request is already merged." });
  } else if (input.state !== "open") {
    blockers.push({ code: "not_open", message: `Pull request state is "${input.state}", not "open".` });
  }

  if (input.draft) {
    blockers.push({ code: "draft", message: "Pull request is a draft. Mark it ready for review first." });
  }

  if (caller && author && caller === author) {
    blockers.push({
      code: "caller_is_author",
      message: `Caller @${input.callerLogin} authored this pull request; merge must be performed by a different agent identity.`
    });
  }

  if (input.expectedHeadSha && input.expectedHeadSha.toLowerCase() !== input.headSha.toLowerCase()) {
    blockers.push({
      code: "head_sha_mismatch",
      message: `expectedHeadSha ${input.expectedHeadSha} does not match the current head ${input.headSha}. The branch moved after it was reviewed.`
    });
  }

  if (input.mergeable === null) {
    blockers.push({
      code: "not_mergeable",
      message: "GitHub has not finished computing mergeability for this pull request. Retry shortly."
    });
  } else if (!input.mergeable) {
    blockers.push({
      code: "not_mergeable",
      message: `Pull request is not mergeable (mergeable_state: ${input.mergeableState}).`
    });
  } else if (!MERGEABLE_STATES.has(input.mergeableState)) {
    blockers.push({
      code: "not_mergeable",
      message: `Pull request mergeable_state is "${input.mergeableState}", which is not a mergeable state.`
    });
  }

  // Latest decision per reviewer wins. COMMENT and PENDING reviews never change
  // a reviewer's standing, so they are ignored entirely; DISMISSED clears a
  // prior approval. GitHub returns reviews oldest-first, so a later entry for
  // the same login legitimately overwrites an earlier one.
  const latestByReviewer = new Map<string, MergeGateReview>();
  for (const review of input.reviews) {
    const state = review.state?.toUpperCase();
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED" && state !== "DISMISSED") {
      continue;
    }
    const key = normalizeLogin(review.login);
    if (!key) continue;
    latestByReviewer.set(key, { ...review, state });
  }

  const approvers: string[] = [];
  const staleApprovers: string[] = [];
  const changesRequestedBy: string[] = [];
  for (const review of latestByReviewer.values()) {
    const login = review.login ?? "";
    if (review.state === "CHANGES_REQUESTED") {
      changesRequestedBy.push(login);
      continue;
    }
    if (review.state !== "APPROVED") continue;
    if (normalizeLogin(login) === author) continue;
    // An approval carries only for the commit it was submitted against.
    if (!review.commitId || review.commitId.toLowerCase() !== input.headSha.toLowerCase()) {
      staleApprovers.push(login);
      continue;
    }
    approvers.push(login);
  }

  if (changesRequestedBy.length > 0) {
    blockers.push({
      code: "changes_requested",
      message: `Changes are still requested by: ${changesRequestedBy.map((l) => `@${l}`).join(", ")}.`
    });
  }

  if (approvers.length < REQUIRED_NON_AUTHOR_APPROVALS) {
    const staleNote = staleApprovers.length > 0
      ? ` ${staleApprovers.length} approval(s) from ${staleApprovers.map((l) => `@${l}`).join(", ")} predate the current head ${input.headSha.slice(0, 7)} and do not count; re-request review.`
      : "";
    blockers.push({
      code: "insufficient_approvals",
      message:
        `Requires ${REQUIRED_NON_AUTHOR_APPROVALS} approving review(s) from distinct non-author reviewers on the current head; ` +
        `found ${approvers.length}${approvers.length > 0 ? ` (${approvers.map((l) => `@${l}`).join(", ")})` : ""}.${staleNote}`
    });
  }

  if (input.unresolvedThreadCount > 0) {
    blockers.push({
      code: "unresolved_review_threads",
      message: `${input.unresolvedThreadCount} review thread(s) are still unresolved.`
    });
  }

  if (input.checksState === "failure") {
    blockers.push({ code: "checks_not_passing", message: `Checks are failing on ${input.headSha.slice(0, 7)}.` });
  } else if (input.checksState === "pending" && input.checkSignalCount > 0) {
    blockers.push({ code: "checks_not_passing", message: `Checks are still running on ${input.headSha.slice(0, 7)}.` });
  }
  // checksState === "pending" with zero signals means the repository reported no
  // check runs, workflow runs, or status contexts at all. There is nothing
  // pending to wait for, so it is not treated as a blocker — but the caller is
  // told explicitly via `checksState: "none"` in the result rather than being
  // shown a green light it did not earn.

  return { ok: blockers.length === 0, blockers, approvers, staleApprovers, changesRequestedBy };
}

/* ------------------------------------------------------------------ */
/* GitHub plumbing                                                     */
/* ------------------------------------------------------------------ */

const GITHUB_API_HEADERS = (token: string) => ({
  "Accept": "application/vnd.github+json",
  "Authorization": `Bearer ${token}`,
  "User-Agent": "paperclip-agent-identities/github-api",
  "X-GitHub-Api-Version": "2022-11-28"
});

async function readErrorDetails(response: Response): Promise<string> {
  try {
    const errBody = (await response.json()) as { message?: string; errors?: unknown };
    const parts: string[] = [];
    if (errBody.message) parts.push(errBody.message);
    if (errBody.errors) parts.push(JSON.stringify(errBody.errors));
    return parts.join(" ");
  } catch {
    return await response.text().catch(() => "");
  }
}

const REVIEWS_PER_PAGE = 100;
const MAX_REVIEW_PAGES = 10;
const THREADS_PER_PAGE = 100;
const MAX_THREAD_PAGES = 10;

const UNRESOLVED_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { isResolved }
      }
    }
  }
}`;

interface ReviewThreadPage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: Array<{ isResolved: boolean }>;
}

interface UnresolvedThreadsData {
  repository: {
    pullRequest: {
      reviewThreads: ReviewThreadPage;
    } | null;
  } | null;
}

export const githubMergePullRequestToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotMergePullRequestToolName,
  metadata: githubBotMergePullRequestToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as MergePullRequestParams;
    const ref = normalizeGitHubRepoRef(params.repository);
    if (!ref) {
      return { ok: false, error: "Invalid repository format" };
    }
    return { ok: true, ref };
  },
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef>
  ): Promise<unknown> {
    if (execution.token === null) {
      return { error: "Internal error: missing resolved credential." };
    }
    const token = execution.token;
    const ctx = execution.ctx;
    const runCtx = execution.runCtx;
    const validated = execution.params as MergePullRequestParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const headers = GITHUB_API_HEADERS(token);
    const prNumber = validated.pullNumber;

    const networkFailure = (stage: string) => {
      ctx.logger.error(`${githubBotMergePullRequestToolName} network failure ${stage}`);
      return { error: "GitHub API request failed before a response was received." };
    };

    // Step 1: the pull request itself — author, state, mergeability, head SHA.
    let prResponse: Response;
    try {
      prResponse = await ctx.http.fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
        { method: "GET", headers }
      );
    } catch {
      return networkFailure("fetching the pull request");
    }
    if (!prResponse.ok) {
      const details = await readErrorDetails(prResponse);
      return {
        error: `GitHub API returned ${prResponse.status} fetching pull request #${prNumber}. ${details}`.trim()
      };
    }
    const pr = (await prResponse.json()) as {
      state: string;
      draft?: boolean;
      merged?: boolean;
      mergeable: boolean | null;
      mergeable_state?: string;
      title: string;
      user: { login: string } | null;
      head: { sha: string };
      base: { ref: string };
    };
    const headSha = pr.head.sha;

    // Step 2: reviews, unresolved threads, and checks for that head, in parallel.
    const reviews: MergeGateReview[] = [];
    const collectReviews = async (): Promise<string | null> => {
      for (let page = 1; page <= MAX_REVIEW_PAGES; page++) {
        const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=${REVIEWS_PER_PAGE}&page=${page}`;
        const response = await ctx.http.fetch(url, { method: "GET", headers });
        if (!response.ok) {
          const details = await readErrorDetails(response);
          return `GitHub API returned ${response.status} fetching reviews for pull request #${prNumber}. ${details}`.trim();
        }
        const body = (await response.json()) as Array<{
          user: { login: string } | null;
          state: string;
          commit_id: string | null;
        }>;
        for (const review of body) {
          reviews.push({ login: review.user?.login ?? null, state: review.state, commitId: review.commit_id });
        }
        if (body.length < REVIEWS_PER_PAGE) return null;
      }
      // Ran out of pages with more still to read. The unread tail is exactly
      // where a blocking CHANGES_REQUESTED would hide, so refuse rather than
      // gate on the prefix — same direction as the truncated CI read.
      return (
        `Pull request #${prNumber} has more than ${MAX_REVIEW_PAGES * REVIEWS_PER_PAGE} reviews. ` +
        `Refusing to judge approvals from a partial read of the review history.`
      );
    };

    const collectUnresolvedThreads = async (): Promise<{ count: number } | { error: string }> => {
      let count = 0;
      let after: string | null = null;
      for (let page = 0; page < MAX_THREAD_PAGES; page++) {
        // Annotated because the cursor written on line 439 feeds back into the
        // call on line 426, and TS cannot infer `result` through that cycle.
        const result: GitHubGraphQLResult<UnresolvedThreadsData> | GitHubGraphQLFailure =
          await executeGitHubGraphQL<UnresolvedThreadsData>(
            ctx,
            token,
            UNRESOLVED_THREADS_QUERY,
            { owner, repo, number: prNumber, first: THREADS_PER_PAGE, after }
          );
        if (!result.ok) {
          return { error: `Failed to read pull request review threads: ${result.error}` };
        }
        const threads: ReviewThreadPage | undefined = result.data.repository?.pullRequest?.reviewThreads;
        if (!threads) {
          return {
            error: `Pull request #${prNumber} was not found in ${repository.fullName} or is not accessible to this GitHub App installation.`
          };
        }
        count += threads.nodes.filter((thread) => !thread.isResolved).length;
        if (!threads.pageInfo.hasNextPage) return { count };
        after = threads.pageInfo.endCursor;
      }
      // Left the loop with `hasNextPage` still true. Returning `count` here
      // would report the partial tally as authoritative, so an unresolved
      // thread past the cap would read as a clean pull request.
      return {
        error:
          `Pull request #${prNumber} has more than ${MAX_THREAD_PAGES * THREADS_PER_PAGE} review threads. ` +
          `Refusing to judge thread resolution from a partial read.`
      };
    };

    const collectChecks = async (): Promise<
      { state: "success" | "failure" | "pending"; signalCount: number } | { error: string }
    > => {
      const [checkRunsResponse, statusResponse, workflowRunsResponse] = await Promise.all([
        ctx.http.fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}`, { method: "GET", headers }),
        ctx.http.fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${headSha}/status`, { method: "GET", headers }),
        ctx.http.fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=${CHECK_RUNS_PER_PAGE}`, { method: "GET", headers })
      ]);
      for (const [label, response] of [
        ["check-runs", checkRunsResponse],
        ["status", statusResponse],
        ["actions runs", workflowRunsResponse]
      ] as const) {
        if (!response.ok) {
          const details = await readErrorDetails(response);
          return { error: `GitHub API returned ${response.status} fetching ${label} for commit ${headSha}. ${details}`.trim() };
        }
      }
      const checkRunsBody = (await checkRunsResponse.json()) as {
        total_count?: number;
        check_runs: Array<{ status: string; conclusion: string | null }>;
      };
      const statusBody = (await statusResponse.json()) as {
        state: string;
        statuses: Array<unknown>;
      };
      const workflowRunsBody = (await workflowRunsResponse.json()) as {
        total_count?: number;
        workflow_runs: Array<{ id?: number; workflow_id?: number; status: string; conclusion: string | null }>;
      };

      // Fail closed on a partial read. Judging CI from page one would let a
      // single red run sitting past the page boundary pass as green, which is
      // the one failure mode this gate exists to make impossible. Erroring is
      // deliberate: an operator seeing "read 100 of 142" knows the gate is
      // undecided, where a silent `success` reads as an earned green light.
      // `/commits/{sha}/status` is exempt — GitHub computes its top-level
      // `state` across every context server-side, so only the `statuses` array
      // truncates, and that array is used solely as a nonzero signal count.
      const truncatedReads = [
        describeTruncatedRead("check runs", checkRunsBody.total_count, checkRunsBody.check_runs.length),
        describeTruncatedRead("workflow runs", workflowRunsBody.total_count, workflowRunsBody.workflow_runs.length)
      ].filter((entry): entry is string => entry !== null);
      if (truncatedReads.length > 0) {
        return {
          error:
            `Could not confirm a complete read of CI for commit ${headSha.slice(0, 7)}: ` +
            `${truncatedReads.join(", ")}. Refusing to judge the merge gate from a partial read of CI.`
        };
      }

      // A `cancelled` record that a later run of the same workflow displaced is
      // an artifact of a `concurrency: cancel-in-progress` group, not a verdict.
      // It never changes, so counting it would pin the pull request at
      // `checks_not_passing` until someone pushes a new commit — which then
      // invalidates every approval. Judge on what was not displaced.
      const judgedWorkflowRuns = dropSupersededWorkflowRuns(workflowRunsBody.workflow_runs);

      const state = computeAggregateState(
        statusBody.state,
        statusBody.statuses.length,
        checkRunsBody.check_runs,
        judgedWorkflowRuns
      );
      return {
        state,
        signalCount: statusBody.statuses.length + checkRunsBody.check_runs.length + judgedWorkflowRuns.length
      };
    };

    // Who is actually merging. This has to come from the credential
    // authenticating the request, not from `identity.githubUsername`: that value
    // is operator-editable config, and on the `plugin-secret` / `token-file`
    // credential paths nothing binds it to the token. A fallback token owned by
    // the pull request author, paired with some other configured username, would
    // otherwise clear the caller-is-author gate while GitHub performed the merge
    // as the author — the one identity the gate exists to exclude.
    //
    // `GET /user` resolves a user token to its real login. A GitHub App
    // installation token cannot act as a user, so GitHub answers it with 403
    // `Resource not accessible by integration`; only that case falls back to the
    // configured username, which the App provisioning path derives from the app
    // slug (`${appSlug}[bot]`) rather than from free-form input. Anything else —
    // 401 on a bad token, a 5xx, a 200 without a login — leaves the acting
    // principal unproven, and an unproven principal is refused rather than
    // assumed to be someone other than the author.
    const resolveCallerLogin = async (): Promise<{ login: string } | { error: string }> => {
      const response = await ctx.http.fetch("https://api.github.com/user", { method: "GET", headers });
      if (response.status === 403) {
        const configured = execution.identity.identity.githubUsername.trim();
        if (!configured) {
          return {
            error:
              "Cannot determine the merging identity: the credential is a GitHub App installation token " +
              "and no githubUsername is configured for this agent identity."
          };
        }
        return { login: configured };
      }
      if (!response.ok) {
        const details = await readErrorDetails(response);
        return {
          error:
            `GitHub API returned ${response.status} resolving the identity behind the merge credential. ` +
            `Refusing to merge without a verified caller. ${details}`.trim()
        };
      }
      const body = (await response.json()) as { login?: unknown };
      if (typeof body.login !== "string" || !body.login.trim()) {
        return {
          error: "GitHub returned no login for the merge credential. Refusing to merge without a verified caller."
        };
      }
      return { login: body.login.trim() };
    };

    let callerResult: Awaited<ReturnType<typeof resolveCallerLogin>>;
    let reviewsError: string | null;
    let threadsResult: Awaited<ReturnType<typeof collectUnresolvedThreads>>;
    let checksResult: Awaited<ReturnType<typeof collectChecks>>;
    try {
      [callerResult, reviewsError, threadsResult, checksResult] = await Promise.all([
        resolveCallerLogin(),
        collectReviews(),
        collectUnresolvedThreads(),
        collectChecks()
      ]);
    } catch {
      return networkFailure("reading the merge gate signals");
    }
    if ("error" in callerResult) return { error: callerResult.error };
    if (reviewsError) return { error: reviewsError };
    if ("error" in threadsResult) return { error: threadsResult.error };
    if ("error" in checksResult) return { error: checksResult.error };

    // Step 3: the gate. Nothing is mutated until every condition holds.
    const gate = evaluateMergeGate({
      callerLogin: callerResult.login,
      authorLogin: pr.user?.login ?? null,
      state: pr.state,
      draft: Boolean(pr.draft),
      merged: Boolean(pr.merged),
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state ?? "unknown",
      headSha,
      expectedHeadSha: validated.expectedHeadSha,
      reviews,
      unresolvedThreadCount: threadsResult.count,
      checksState: checksResult.state,
      checkSignalCount: checksResult.signalCount
    });

    const checksLabel = checksResult.signalCount === 0 ? "none" : checksResult.state;

    if (!gate.ok) {
      const reasons = gate.blockers.map((blocker) => `- ${blocker.message}`).join("\n");
      ctx.logger.info(
        `Refused to merge pull request #${prNumber} in ${repository.fullName}: ` +
        gate.blockers.map((blocker) => blocker.code).join(", ")
      );
      return {
        error:
          `Merge gate refused pull request #${prNumber} in ${repository.fullName} (head ${headSha.slice(0, 7)}):\n${reasons}`,
        data: {
          merged: false,
          headSha,
          blockers: gate.blockers,
          approvers: gate.approvers,
          staleApprovers: gate.staleApprovers,
          changesRequestedBy: gate.changesRequestedBy,
          unresolvedThreadCount: threadsResult.count,
          checksState: checksLabel
        }
      };
    }

    // Step 4: merge, pinned to the exact head the gate was evaluated against.
    // A push landing between step 1 and here makes GitHub reject with 409
    // rather than merging code no reviewer approved.
    const mergeBody: Record<string, unknown> = {
      merge_method: validated.mergeMethod,
      sha: headSha
    };
    if (validated.commitTitle !== undefined) mergeBody.commit_title = validated.commitTitle;
    if (validated.commitBody !== undefined) mergeBody.commit_message = validated.commitBody;

    let mergeResponse: Response;
    try {
      mergeResponse = await ctx.http.fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`,
        {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(mergeBody)
        }
      );
    } catch {
      return networkFailure("merging the pull request");
    }

    if (!mergeResponse.ok) {
      const details = await readErrorDetails(mergeResponse);
      const hint = mergeResponse.status === 409
        ? " The head commit moved after the merge gate passed, or the branch is out of date."
        : "";
      return {
        error: `GitHub API returned ${mergeResponse.status} merging pull request #${prNumber}. ${details}${hint}`.trim(),
        data: { merged: false, headSha, checksState: checksLabel }
      };
    }

    const merged = (await mergeResponse.json()) as { sha: string; merged: boolean; message: string };

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Merged pull request #${prNumber} in ${repository.fullName} (${validated.mergeMethod})`,
      entityType: "pull_request_merge",
      entityId: String(prNumber),
      metadata: {
        repository: repository.fullName,
        prNumber,
        mergeMethod: validated.mergeMethod,
        headSha,
        mergeCommitSha: merged.sha,
        baseRef: pr.base.ref,
        approvers: gate.approvers,
        checksState: checksLabel,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(
      `Merged pull request #${prNumber} in ${repository.fullName} as ${merged.sha} (${validated.mergeMethod})`
    );

    return {
      content:
        `Merged PR #${prNumber} (${validated.mergeMethod}) into ${pr.base.ref} as ${merged.sha.slice(0, 7)}. ` +
        `Approved by ${gate.approvers.map((login) => `@${login}`).join(", ")}.`,
      data: {
        merged: true,
        mergeCommitSha: merged.sha,
        headSha,
        mergeMethod: validated.mergeMethod,
        baseRef: pr.base.ref,
        approvers: gate.approvers,
        checksState: checksLabel,
        message: merged.message
      }
    };
  }
};
