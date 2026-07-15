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
  githubBotSubmitPullRequestReviewToolMetadata,
  githubBotSubmitPullRequestReviewToolName
} from "../../../shared/github-bot-submit-pull-request-review-tool.js";

export type SubmitPullRequestReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export interface SubmitPullRequestReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface SubmitPullRequestReviewParams {
  repository: string;
  pullNumber: number;
  event: SubmitPullRequestReviewEvent;
  body?: string;
  comments?: SubmitPullRequestReviewComment[];
  paperclipIssueId?: string;
}

const VALID_EVENTS: readonly SubmitPullRequestReviewEvent[] = ["APPROVE", "REQUEST_CHANGES", "COMMENT"];

function validateComment(raw: unknown, index: number): { ok: true; comment: SubmitPullRequestReviewComment } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: `comments[${index}] must be an object` };
  }
  const c = raw as Record<string, unknown>;
  if (!c.path || typeof c.path !== "string") {
    return { ok: false, error: `comments[${index}].path is required` };
  }
  if (typeof c.line !== "number" || !Number.isInteger(c.line) || c.line <= 0) {
    return { ok: false, error: `comments[${index}].line must be a positive integer` };
  }
  if (!c.body || typeof c.body !== "string") {
    return { ok: false, error: `comments[${index}].body is required` };
  }
  return { ok: true, comment: { path: c.path, line: c.line, body: c.body } };
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
  if (typeof p.event !== "string" || !VALID_EVENTS.includes(p.event as SubmitPullRequestReviewEvent)) {
    return { ok: false, error: 'event must be one of "APPROVE", "REQUEST_CHANGES", "COMMENT"' };
  }
  if (p.body !== undefined && typeof p.body !== "string") {
    return { ok: false, error: "body must be a string if provided" };
  }
  const comments: SubmitPullRequestReviewComment[] = [];
  if (p.comments !== undefined) {
    if (!Array.isArray(p.comments)) {
      return { ok: false, error: "comments must be an array if provided" };
    }
    for (let i = 0; i < p.comments.length; i++) {
      const result = validateComment(p.comments[i], i);
      if (!result.ok) {
        return { ok: false, error: result.error };
      }
      comments.push(result.comment);
    }
  }
  const hasBody = typeof p.body === "string" && p.body.trim().length > 0;
  if (!hasBody && comments.length === 0) {
    return { ok: false, error: "body is required when no inline comments are provided" };
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }

  const validated: SubmitPullRequestReviewParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    event: p.event as SubmitPullRequestReviewEvent,
    body: p.body as string | undefined,
    comments: comments.length > 0 ? comments : undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

export const githubSubmitPullRequestReviewToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotSubmitPullRequestReviewToolName,
  metadata: githubBotSubmitPullRequestReviewToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as SubmitPullRequestReviewParams;
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
    const validated = execution.params as SubmitPullRequestReviewParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${validated.pullNumber}/reviews`;

    const requestBody: Record<string, unknown> = {
      event: validated.event
    };
    if (validated.body !== undefined) {
      requestBody.body = validated.body;
    }
    if (validated.comments && validated.comments.length > 0) {
      requestBody.comments = validated.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        body: comment.body
      }));
    }

    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_submit_pull_request_review network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} submitting the pull request review. ${details}`.trim()
      };
    }

    const created = (await response.json()) as {
      id: number;
      html_url: string;
      state: string;
      body: string;
    };

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Submitted ${validated.event} review on pull request #${validated.pullNumber} in ${repository.fullName}`,
      entityType: "pull_request_review",
      entityId: String(created.id),
      metadata: {
        repository: repository.fullName,
        prNumber: validated.pullNumber,
        reviewId: created.id,
        reviewUrl: created.html_url,
        event: validated.event,
        inlineCommentCount: validated.comments?.length ?? 0,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(
      `Submitted ${validated.event} review #${created.id} on pull request #${validated.pullNumber} in ${repository.fullName}`
    );

    return {
      content: `Submitted ${validated.event} review on PR #${validated.pullNumber}: ${created.html_url}`,
      data: {
        id: created.id,
        url: created.html_url,
        state: created.state,
        event: validated.event
      }
    };
  }
};
