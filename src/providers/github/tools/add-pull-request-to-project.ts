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
import {
  githubBotAddPullRequestToProjectToolMetadata,
  githubBotAddPullRequestToProjectToolName
} from "../../../shared/github-bot-add-pull-request-to-project-tool.js";

export interface AddPullRequestToProjectParams {
  repository: string;
  pullNumber: number;
  projectId: string;
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
  if (!p.projectId || typeof p.projectId !== "string") {
    return { ok: false, error: "projectId is required (the Projects v2 node ID)" };
  }
  const validated: AddPullRequestToProjectParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    projectId: p.projectId
  };
  return { ok: true, params: validated };
}

const FIND_PULL_REQUEST_NODE_ID_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      url
    }
  }
}`;

interface FindPullRequestNodeIdGraphQLData {
  repository: {
    pullRequest: { id: string; url: string } | null;
  } | null;
}

const ADD_PROJECT_V2_ITEM_MUTATION = `
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item {
      id
    }
  }
}`;

interface AddProjectV2ItemGraphQLData {
  addProjectV2ItemById: {
    item: { id: string } | null;
  };
}

export const githubAddPullRequestToProjectToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotAddPullRequestToProjectToolName,
  metadata: githubBotAddPullRequestToProjectToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as AddPullRequestToProjectParams;
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
    const validated = execution.params as AddPullRequestToProjectParams;
    const repository = execution.resourceRef as GitHubRepoRef;

    const prLookup = await executeGitHubGraphQL<FindPullRequestNodeIdGraphQLData>(
      ctx,
      token,
      FIND_PULL_REQUEST_NODE_ID_QUERY,
      { owner: repository.owner, repo: repository.repo, number: validated.pullNumber }
    );

    if (!prLookup.ok) {
      return { error: `Failed to look up pull request #${validated.pullNumber} in ${repository.fullName}: ${prLookup.error}` };
    }

    const pullRequest = prLookup.data.repository?.pullRequest ?? null;
    if (!pullRequest) {
      return { error: `Pull request #${validated.pullNumber} was not found in ${repository.fullName}.` };
    }

    const addResult = await executeGitHubGraphQL<AddProjectV2ItemGraphQLData>(
      ctx,
      token,
      ADD_PROJECT_V2_ITEM_MUTATION,
      { projectId: validated.projectId, contentId: pullRequest.id }
    );

    if (!addResult.ok) {
      return { error: `Failed to add pull request #${validated.pullNumber} to project '${validated.projectId}': ${addResult.error}` };
    }

    const item = addResult.data.addProjectV2ItemById.item;
    if (!item) {
      return { error: `GitHub did not return a project item for pull request #${validated.pullNumber}.` };
    }

    await ctx.activity.log({
      companyId: execution.runCtx.companyId,
      message: `Added pull request #${validated.pullNumber} in ${repository.fullName} to project ${validated.projectId}`,
      entityType: "pull_request",
      entityId: String(validated.pullNumber),
      metadata: {
        repository: repository.fullName,
        prNumber: validated.pullNumber,
        prUrl: pullRequest.url,
        projectId: validated.projectId,
        projectItemId: item.id,
        agentId: execution.runCtx.agentId
      }
    });
    ctx.logger.info(`Added pull request #${validated.pullNumber} in ${repository.fullName} to project ${validated.projectId}`);

    return {
      content: `Added PR #${validated.pullNumber} (${pullRequest.url}) to project ${validated.projectId}.`,
      data: {
        repository: repository.fullName,
        pullNumber: validated.pullNumber,
        pullRequestUrl: pullRequest.url,
        projectId: validated.projectId,
        projectItemId: item.id
      }
    };
  }
};
