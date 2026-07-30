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
import { executeGitHubGraphQL } from "../graphql.js";
import { appendAiAuthorshipFooter } from "../../../shared/github-ai-authorship-footer.js";
import {
  githubBotReplyToReviewThreadToolMetadata,
  githubBotReplyToReviewThreadToolName
} from "../../../shared/github-bot-reply-to-review-thread-tool.js";

export interface ReplyToReviewThreadParams {
  repository: string;
  reviewThreadId: string;
  body: string;
  llmModel?: string;
  paperclipIssueId?: string;
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.repository || typeof p.repository !== "string") {
    return { ok: false, error: 'repository is required (e.g. "my-org/my-repo")' };
  }
  if (!p.reviewThreadId || typeof p.reviewThreadId !== "string") {
    return { ok: false, error: "reviewThreadId is required" };
  }
  if (!p.body || typeof p.body !== "string" || !p.body.trim()) {
    return { ok: false, error: "body is required" };
  }
  if (p.llmModel !== undefined && typeof p.llmModel !== "string") {
    return { ok: false, error: "llmModel must be a string if provided" };
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }
  const validated: ReplyToReviewThreadParams = {
    repository: p.repository,
    reviewThreadId: p.reviewThreadId,
    body: p.body,
    llmModel: p.llmModel as string | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

const REPLY_TO_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment {
      id
      databaseId
      url
      body
    }
  }
}`;

interface ReplyToReviewThreadGraphQLData {
  addPullRequestReviewThreadReply: {
    comment: {
      id: string;
      databaseId: number | null;
      url: string;
      body: string;
    };
  };
}

export const githubReplyToReviewThreadToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotReplyToReviewThreadToolName,
  metadata: githubBotReplyToReviewThreadToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as ReplyToReviewThreadParams;
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
    const validated = execution.params as ReplyToReviewThreadParams;
    const repository = execution.resourceRef as GitHubRepoRef;

    const bodyWithFooter = appendAiAuthorshipFooter(validated.body, validated.llmModel);

    const result = await executeGitHubGraphQL<ReplyToReviewThreadGraphQLData>(
      ctx,
      token,
      REPLY_TO_REVIEW_THREAD_MUTATION,
      { threadId: validated.reviewThreadId, body: bodyWithFooter }
    );

    if (!result.ok) {
      return { error: `Failed to reply to review thread: ${result.error}` };
    }

    const comment = result.data.addPullRequestReviewThreadReply.comment;

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Replied to review thread ${validated.reviewThreadId} in ${repository.fullName}`,
      entityType: "review_thread_reply",
      entityId: comment.id,
      metadata: {
        repository: repository.fullName,
        reviewThreadId: validated.reviewThreadId,
        commentId: comment.id,
        commentUrl: comment.url,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(`Replied to review thread ${validated.reviewThreadId} in ${repository.fullName}: ${comment.url}`);

    return {
      content: `Replied to review thread: ${comment.url}`,
      data: {
        id: comment.id,
        url: comment.url
      }
    };
  }
};
