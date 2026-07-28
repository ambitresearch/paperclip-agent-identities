import type { ResourceReference } from "../../../core/resource-reference.js";
import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import { executeGitHubGraphQL } from "../graphql.js";
import {
  githubBotListOrganizationProjectsToolMetadata,
  githubBotListOrganizationProjectsToolName
} from "../../../shared/github-bot-list-organization-projects-tool.js";

export interface GitHubOrgRef extends ResourceReference {
  readonly kind: "github-org";
  readonly organization: string;
}

export interface ListOrganizationProjectsParams {
  organization: string;
  query?: string;
  first?: number;
}

const DEFAULT_FIRST = 20;
const MAX_FIRST = 100;

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.organization || typeof p.organization !== "string") {
    return { ok: false, error: 'organization is required (e.g. "my-org")' };
  }
  if (p.query !== undefined && typeof p.query !== "string") {
    return { ok: false, error: "query must be a string if provided" };
  }
  if (p.first !== undefined) {
    if (typeof p.first !== "number" || !Number.isInteger(p.first) || p.first <= 0) {
      return { ok: false, error: "first must be a positive integer if provided" };
    }
    if (p.first > MAX_FIRST) {
      return { ok: false, error: `first must be at most ${MAX_FIRST}` };
    }
  }
  const validated: ListOrganizationProjectsParams = {
    organization: p.organization,
    query: p.query as string | undefined,
    first: p.first as number | undefined
  };
  return { ok: true, params: validated };
}

const LIST_ORG_PROJECTS_QUERY = `
query($login: String!, $first: Int!, $query: String) {
  organization(login: $login) {
    projectsV2(first: $first, query: $query) {
      nodes {
        id
        number
        title
        url
        closed
        public
      }
    }
  }
}`;

interface ListOrgProjectsGraphQLData {
  organization: {
    projectsV2: {
      nodes: Array<{
        id: string;
        number: number;
        title: string;
        url: string;
        closed: boolean;
        public: boolean;
      }>;
    };
  } | null;
}

export const githubListOrganizationProjectsToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubOrgRef> = {
  name: githubBotListOrganizationProjectsToolName,
  metadata: githubBotListOrganizationProjectsToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubOrgRef>> {
    const params = input.params as ListOrganizationProjectsParams;
    const organization = params.organization?.trim().toLowerCase();
    if (!organization) {
      return { ok: false, error: "Invalid organization" };
    }
    return { ok: true, ref: { kind: "github-org", organization } };
  },
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, GitHubOrgRef>
  ): Promise<unknown> {
    if (execution.token === null) {
      return { error: "Internal error: missing resolved credential." };
    }
    const token = execution.token;
    const ctx = execution.ctx;
    const validated = execution.params as ListOrganizationProjectsParams;
    const orgRef = execution.resourceRef as GitHubOrgRef;
    const first = Math.min(validated.first ?? DEFAULT_FIRST, MAX_FIRST);

    const result = await executeGitHubGraphQL<ListOrgProjectsGraphQLData>(ctx, token, LIST_ORG_PROJECTS_QUERY, {
      login: orgRef.organization,
      first,
      query: validated.query ?? null
    });

    if (!result.ok) {
      return { error: `Failed to list organization projects: ${result.error}` };
    }

    if (!result.data.organization) {
      return { error: `Organization '${orgRef.organization}' was not found or is not accessible to this GitHub App installation.` };
    }

    const projects = result.data.organization.projectsV2.nodes.map((node) => ({
      id: node.id,
      number: node.number,
      title: node.title,
      url: node.url,
      closed: node.closed,
      public: node.public
    }));

    ctx.logger.info(`Listed ${projects.length} Projects v2 for organization ${orgRef.organization}`);

    return {
      content: `Found ${projects.length} project(s) in ${orgRef.organization}.`,
      data: { organization: orgRef.organization, projects }
    };
  }
};
