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
import { executeGitHubGraphQL, verifyReviewThreadBelongsToRepository } from "../graphql.js";
import {
  githubBotUnresolveReviewThreadToolMetadata,
  githubBotUnresolveReviewThreadToolName
} from "../../../shared/github-bot-unresolve-review-thread-tool.js";

export interface UnresolveReviewThreadParams {
  repository: string;
  reviewThreadId: string;
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
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }
  const validated: UnresolveReviewThreadParams = {
    repository: p.repository,
    reviewThreadId: p.reviewThreadId,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

const UNRESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  unresolveReviewThread(input: { threadId: $threadId }) {
    thread {
      id
      isResolved
    }
  }
}`;

interface UnresolveReviewThreadGraphQLData {
  unresolveReviewThread: {
    thread: {
      id: string;
      isResolved: boolean;
    };
  };
}

export const githubUnresolveReviewThreadToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotUnresolveReviewThreadToolName,
  metadata: githubBotUnresolveReviewThreadToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as UnresolveReviewThreadParams;
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
    const validated = execution.params as UnresolveReviewThreadParams;
    const repository = execution.resourceRef as GitHubRepoRef;

    const ownership = await verifyReviewThreadBelongsToRepository(ctx, token, validated.reviewThreadId, {
      owner: repository.owner,
      repo: repository.repo
    });
    if (!ownership.ok) {
      return { error: ownership.error };
    }

    const result = await executeGitHubGraphQL<UnresolveReviewThreadGraphQLData>(
      ctx,
      token,
      UNRESOLVE_REVIEW_THREAD_MUTATION,
      { threadId: validated.reviewThreadId }
    );

    if (!result.ok) {
      return { error: `Failed to unresolve review thread: ${result.error}` };
    }

    const thread = result.data.unresolveReviewThread.thread;

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Unresolved review thread ${thread.id} in ${repository.fullName}`,
      entityType: "review_thread",
      entityId: thread.id,
      metadata: {
        repository: repository.fullName,
        reviewThreadId: thread.id,
        isResolved: thread.isResolved,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(`Unresolved review thread ${thread.id} in ${repository.fullName}`);

    return {
      content: `Unresolved review thread ${thread.id}.`,
      data: {
        id: thread.id,
        isResolved: thread.isResolved
      }
    };
  }
};
