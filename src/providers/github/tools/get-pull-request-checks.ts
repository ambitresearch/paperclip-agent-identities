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
    const checkRunsUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs`;
    const statusUrl = `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`;
    const workflowRunsUrl = `https://api.github.com/repos/${owner}/${repo}/actions/runs?head_sha=${sha}`;

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

    ctx.logger.info(
      `Fetched checks for pull request #${validated.pullNumber} in ${repository.fullName}: ` +
      `${checkRuns.length} check run(s), ${statusContexts.length} status context(s), ${workflowRuns.length} workflow run(s)`
    );

    return {
      content:
        `Pull request #${validated.pullNumber} (${sha.slice(0, 7)}): overall status ${statusBody.state}, ` +
        `${checkRuns.length} check run(s), ${workflowRuns.length} workflow run(s)`,
      data: {
        sha,
        overallState: statusBody.state,
        checkRuns,
        statusContexts,
        workflowRuns
      }
    };
  }
};
