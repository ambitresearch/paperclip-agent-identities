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
import {
  githubBotGetPullRequestChecksToolMetadata,
  githubBotGetPullRequestChecksToolName
} from "../../../shared/github-bot-get-pull-request-checks-tool.js";

export interface GetPullRequestChecksParams {
  repository: string;
  pullNumber: number;
}

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
  const validated: GetPullRequestChecksParams = {
    repository: p.repository,
    pullNumber: p.pullNumber
  };
  return { ok: true, params: validated };
}

interface GitHubApiError {
  message?: string;
  errors?: unknown;
}

async function readErrorDetails(response: Response): Promise<string> {
  try {
    const errBody = (await response.json()) as GitHubApiError;
    const parts: string[] = [];
    if (errBody.message) parts.push(errBody.message);
    if (errBody.errors) parts.push(JSON.stringify(errBody.errors));
    return parts.join(" ");
  } catch {
    return await response.text().catch(() => "");
  }
}

const GITHUB_API_HEADERS = (token: string) => ({
  "Accept": "application/vnd.github+json",
  "Authorization": `Bearer ${token}`,
  "User-Agent": "paperclip-agent-identities/github-api",
  "X-GitHub-Api-Version": "2022-11-28"
});

/**
 * GitHub defaults `/check-runs` and `/actions/runs` to 30 items per page and
 * caps them at 100. Both report the true size in `total_count` alongside the
 * page, so ask for the maximum and then verify the two agree — a matrix build
 * passes 30 runs easily, and `filter=latest` dedups by check *name*, not by job.
 */
export const CHECK_RUNS_PER_PAGE = 100;

/**
 * Describe a read that cannot be proven complete, or `null` when the page
 * demonstrably carried everything. A caller that judges CI from a truncated
 * slice can call a red commit green, so every consumer of these endpoints has
 * to notice the gap rather than silently treat page one as the whole story.
 */
export function describeTruncatedRead(
  label: string,
  totalCount: unknown,
  receivedCount: number
): string | null {
  // A page filled exactly to the cap has the same shape whether it is complete
  // or truncated; only `total_count` tells the two apart. GitHub documents that
  // field on both endpoints, so an unusable one is not a case the real API
  // produces — but the cost of guessing wrong is a red commit judged green, and
  // this module already refuses to act on missing evidence elsewhere
  // (`dropSupersededWorkflowRuns` keeps a run whose displacement it cannot
  // prove). So an absent or type-drifted total means "unproven", not "complete":
  // a short page still carried everything, a full one is treated as suspect.
  if (typeof totalCount !== "number" || !Number.isFinite(totalCount)) {
    return receivedCount >= CHECK_RUNS_PER_PAGE
      ? `${label} (read ${receivedCount}; GitHub reported no usable total)`
      : null;
  }
  if (totalCount <= receivedCount) return null;
  return `${label} (read ${receivedCount} of ${totalCount})`;
}

/** Conclusions that mean "this finished and it did not pass". */
const FAILING_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale"
]);

/**
 * The subset of failing conclusions GitHub writes when a run was *displaced*
 * rather than judged. Only these are eligible to be discarded as superseded;
 * every other failing conclusion records a real verdict and is never dropped.
 */
const SUPERSEDING_CONCLUSIONS = new Set(["cancelled", "stale"]);

/**
 * Drop workflow runs that a later run of the same workflow displaced.
 *
 * `/actions/runs?head_sha=` returns *every* run ever created for a commit, and
 * nothing ever rewrites a `cancelled` record. A workflow that triggers on both
 * `push` and `pull_request` under a `concurrency: cancel-in-progress` group
 * therefore leaves a permanent `cancelled` run behind on its first trigger.
 * Counting that as fatal pins the pull request at "checks not passing" with no
 * escape but a new commit — which then invalidates every approval, so the two
 * behaviors compound.
 *
 * Only displaced runs are dropped. A `cancelled` run that is still the newest
 * for its workflow was cancelled deliberately and stays fatal. Run ids increase
 * monotonically per repository, so the highest id within a workflow is the
 * newest. A manual cancel followed by "re-run all jobs" is unaffected either
 * way: that reuses the run id and overwrites the conclusion in place.
 */
export function dropSupersededWorkflowRuns<
  T extends { id?: number; workflow_id?: number; conclusion: string | null }
>(workflowRuns: T[]): T[] {
  const newestIdByWorkflow = new Map<number, number>();
  for (const run of workflowRuns) {
    if (typeof run.id !== "number" || typeof run.workflow_id !== "number") continue;
    const newest = newestIdByWorkflow.get(run.workflow_id);
    if (newest === undefined || run.id > newest) newestIdByWorkflow.set(run.workflow_id, run.id);
  }
  return workflowRuns.filter((run) => {
    if (run.conclusion === null || !SUPERSEDING_CONCLUSIONS.has(run.conclusion)) return true;
    // Without both ids there is no way to tell displaced from deliberate, so
    // keep the run and let it block. Fail closed on missing evidence.
    if (typeof run.id !== "number" || typeof run.workflow_id !== "number") return true;
    return newestIdByWorkflow.get(run.workflow_id) === run.id;
  });
}

/**
 * Roll the legacy combined commit-status state together with check runs and workflow
 * runs into one state. Precedence is failure > pending > success, so a red Actions job
 * can never be masked by green legacy statuses. `success` requires that at least one
 * signal actually reported; with no signals at all the result is `pending`.
 */
export function computeAggregateState(
  combinedState: string,
  statusContextCount: number,
  checkRuns: Array<{ status: string; conclusion: string | null }>,
  workflowRuns: Array<{ status: string; conclusion: string | null }>
): "success" | "failure" | "pending" {
  let sawSignal = statusContextCount > 0;
  let sawPending = false;

  if (statusContextCount > 0) {
    if (combinedState === "failure" || combinedState === "error") return "failure";
    if (combinedState !== "success") sawPending = true;
  }

  for (const run of [...checkRuns, ...workflowRuns]) {
    sawSignal = true;
    if (run.status !== "completed") {
      sawPending = true;
      continue;
    }
    // A completed run with no conclusion is indeterminate, not a pass.
    if (run.conclusion === null) {
      sawPending = true;
      continue;
    }
    if (FAILING_CONCLUSIONS.has(run.conclusion)) return "failure";
    // `success`, `neutral`, and `skipped` are all non-blocking passes.
  }

  if (sawPending) return "pending";
  return sawSignal ? "success" : "pending";
}

export const githubGetPullRequestChecksToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotGetPullRequestChecksToolName,
  metadata: githubBotGetPullRequestChecksToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as GetPullRequestChecksParams;
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
    const validated = execution.params as GetPullRequestChecksParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const headers = GITHUB_API_HEADERS(token);

    // Step 1: resolve the PR's head SHA.
    const prUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${validated.pullNumber}`;
    let prResponse: Response;
    try {
      prResponse = await ctx.http.fetch(prUrl, { method: "GET", headers });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_get_pull_request_checks network failure fetching PR: ${reason}`);
      return { error: "GitHub API request failed before a response was received." };
    }
    if (!prResponse.ok) {
      const details = await readErrorDetails(prResponse);
      return {
        error: `GitHub API returned ${prResponse.status} fetching pull request #${validated.pullNumber}. ${details}`.trim()
      };
    }
    const pr = (await prResponse.json()) as { head: { sha: string } };
    const sha = pr.head.sha;

    // Step 2: check runs, commit status, and Actions workflow runs for that SHA, in parallel.
    const checkRunsUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE}`;
    const statusUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`;
    const workflowRunsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=${CHECK_RUNS_PER_PAGE}`;

    let checkRunsResponse: Response;
    let statusResponse: Response;
    let workflowRunsResponse: Response;
    try {
      [checkRunsResponse, statusResponse, workflowRunsResponse] = await Promise.all([
        ctx.http.fetch(checkRunsUrl, { method: "GET", headers }),
        ctx.http.fetch(statusUrl, { method: "GET", headers }),
        ctx.http.fetch(workflowRunsUrl, { method: "GET", headers })
      ]);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_get_pull_request_checks network failure fetching checks: ${reason}`);
      return { error: "GitHub API request failed before a response was received." };
    }

    for (const [label, response] of [
      ["check-runs", checkRunsResponse],
      ["status", statusResponse],
      ["actions runs", workflowRunsResponse]
    ] as const) {
      if (!response.ok) {
        const details = await readErrorDetails(response);
        return {
          error: `GitHub API returned ${response.status} fetching ${label} for commit ${sha}. ${details}`.trim()
        };
      }
    }

    const checkRunsBody = (await checkRunsResponse.json()) as {
      total_count: number;
      check_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        started_at: string | null;
        completed_at: string | null;
        html_url: string;
      }>;
    };
    const statusBody = (await statusResponse.json()) as {
      state: string;
      statuses: Array<{
        context: string;
        state: string;
        description: string | null;
        target_url: string | null;
      }>;
    };
    const workflowRunsBody = (await workflowRunsResponse.json()) as {
      total_count: number;
      workflow_runs: Array<{
        id: number;
        workflow_id: number;
        name: string | null;
        status: string;
        conclusion: string | null;
        html_url: string;
        run_started_at: string | null;
      }>;
    };

    const checkRuns = checkRunsBody.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.started_at,
      completedAt: run.completed_at,
      url: run.html_url
    }));
    const statusContexts = statusBody.statuses.map((status) => ({
      context: status.context,
      state: status.state,
      description: status.description,
      url: status.target_url
    }));
    const workflowRuns = workflowRunsBody.workflow_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      startedAt: run.run_started_at
    }));
    // Every run GitHub returned is still reported, so a lingering `cancelled`
    // record stays visible to whoever is reading; only the aggregate verdict
    // ignores the ones a later run of the same workflow displaced.
    const judgedWorkflowRuns = dropSupersededWorkflowRuns(workflowRunsBody.workflow_runs);

    // `statusBody.state` is only the legacy combined *commit status* state. It ignores
    // check runs and workflow runs entirely, so a PR with a failing GitHub Actions job
    // reports `success` whenever its legacy contexts pass (and `pending` when there are
    // none at all). Roll all three signals into a single aggregate the caller can trust,
    // and keep the legacy value under its own explicit name.
    const rawAggregateState = computeAggregateState(
      statusBody.state,
      statusBody.statuses.length,
      checkRuns,
      judgedWorkflowRuns
    );

    // A page that did not carry every run cannot support a green verdict: the one
    // failure could be sitting in the part we never read. `failure` survives
    // truncation (a red run we *did* see is still red); only `success` degrades.
    // `statusBody.state` needs no such guard — GitHub computes it server-side
    // across every context, so only the `statuses` array truncates.
    const truncatedReads = [
      describeTruncatedRead("check runs", checkRunsBody.total_count, checkRuns.length),
      describeTruncatedRead("workflow runs", workflowRunsBody.total_count, workflowRuns.length)
    ].filter((entry): entry is string => entry !== null);
    const aggregateState =
      truncatedReads.length > 0 && rawAggregateState === "success" ? "pending" : rawAggregateState;

    ctx.logger.info(
      `Fetched checks for pull request #${validated.pullNumber} in ${repository.fullName}: ` +
      `${checkRuns.length} check run(s), ${statusContexts.length} status context(s), ${workflowRuns.length} workflow run(s)`
    );

    return {
      content:
        `Pull request #${validated.pullNumber} (${sha.slice(0, 7)}): overall status ${aggregateState}, ` +
        `${checkRuns.length} check run(s), ${workflowRuns.length} workflow run(s)` +
        (truncatedReads.length > 0
          ? `. Incomplete read of ${truncatedReads.join(" and ")}; the status shown covers only what was read.`
          : ""),
      data: {
        sha,
        overallState: aggregateState,
        combinedStatusState: statusBody.state,
        ...(truncatedReads.length > 0 ? { truncated: truncatedReads } : {}),
        checkRuns,
        statusContexts,
        workflowRuns
      }
    };
  }
};
