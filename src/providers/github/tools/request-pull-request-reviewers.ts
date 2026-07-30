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
  githubBotRequestPullRequestReviewersToolMetadata,
  githubBotRequestPullRequestReviewersToolName
} from "../../../shared/github-bot-request-pull-request-reviewers-tool.js";

export interface RequestPullRequestReviewersParams {
  repository: string;
  pullNumber: number;
  reviewers?: string[];
  teamReviewers?: string[];
  paperclipIssueId?: string;
}

function validateStringArray(raw: unknown, field: string): { ok: true; values: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${field} must be an array of strings if provided` };
  }
  const values: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (typeof raw[i] !== "string" || (raw[i] as string).trim().length === 0) {
      return { ok: false, error: `${field}[${i}] must be a non-empty string` };
    }
    values.push(raw[i] as string);
  }
  return { ok: true, values };
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

  let reviewers: string[] = [];
  if (p.reviewers !== undefined) {
    const result = validateStringArray(p.reviewers, "reviewers");
    if (!result.ok) return result;
    reviewers = result.values;
  }

  let teamReviewers: string[] = [];
  if (p.teamReviewers !== undefined) {
    const result = validateStringArray(p.teamReviewers, "teamReviewers");
    if (!result.ok) return result;
    teamReviewers = result.values;
  }

  if (reviewers.length === 0 && teamReviewers.length === 0) {
    return { ok: false, error: "at least one of reviewers or teamReviewers is required" };
  }

  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }

  const validated: RequestPullRequestReviewersParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    reviewers: reviewers.length > 0 ? reviewers : undefined,
    teamReviewers: teamReviewers.length > 0 ? teamReviewers : undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

export const githubRequestPullRequestReviewersToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotRequestPullRequestReviewersToolName,
  metadata: githubBotRequestPullRequestReviewersToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as RequestPullRequestReviewersParams;
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
    const validated = execution.params as RequestPullRequestReviewersParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${validated.pullNumber}/requested_reviewers`;

    const requestBody: Record<string, unknown> = {};
    if (validated.reviewers && validated.reviewers.length > 0) {
      requestBody.reviewers = validated.reviewers;
    }
    if (validated.teamReviewers && validated.teamReviewers.length > 0) {
      requestBody.team_reviewers = validated.teamReviewers;
    }

    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "paperclip-agent-identities/github-api",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_request_pull_request_reviewers network failure: ${reason}`);
      return { error: "GitHub API request failed before a response was received." };
    }

    if (!response.ok) {
      let details = "";
      try {
        const errBody = (await response.json()) as { message?: string; errors?: unknown };
        const parts: string[] = [];
        if (errBody.message) parts.push(errBody.message);
        if (errBody.errors) parts.push(JSON.stringify(errBody.errors));
        details = parts.join(" ");
      } catch {
        details = await response.text().catch(() => "");
      }
      return {
        error: `GitHub API returned ${response.status} requesting reviewers on pull request #${validated.pullNumber}. ${details}`.trim()
      };
    }

    const updated = (await response.json()) as {
      number: number;
      html_url: string;
      requested_reviewers?: Array<{ login: string }>;
      requested_teams?: Array<{ slug: string }>;
    };

    const requestedReviewers = (updated.requested_reviewers ?? []).map((u) => u.login);
    const requestedTeams = (updated.requested_teams ?? []).map((t) => t.slug);

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Requested reviewers on pull request #${validated.pullNumber} in ${repository.fullName}`,
      entityType: "pull_request",
      entityId: String(updated.number),
      metadata: {
        repository: repository.fullName,
        prNumber: updated.number,
        prUrl: updated.html_url,
        requestedReviewers,
        requestedTeams,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(
      `Requested reviewers on pull request #${validated.pullNumber} in ${repository.fullName}: ` +
      `${requestedReviewers.join(", ") || "(none)"}${requestedTeams.length > 0 ? ` teams: ${requestedTeams.join(", ")}` : ""}`
    );

    return {
      content: `Requested reviewers on PR #${validated.pullNumber}: ${updated.html_url}`,
      data: {
        number: updated.number,
        url: updated.html_url,
        requestedReviewers,
        requestedTeams
      }
    };
  }
};
