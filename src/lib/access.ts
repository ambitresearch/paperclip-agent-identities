export type ContributionTool = "github.push" | "github.pr.create";

export interface IdentityConfig {
  companyId: string;
  githubUsername: string;
  githubToken: string;
}

export interface BotIdentityPluginConfig {
  identities?: Record<string, IdentityConfig>;
  defaultIdentityAlias?: string;
  allowedCompanyIds?: string[];
}

export interface RequestContext {
  companyId?: string;
  identityAlias?: string;
}

export interface ContributionAccess {
  allowed: boolean;
  deniedTools: ContributionTool[];
  identity?: IdentityConfig;
  reason?: "identity_missing" | "company_context_missing" | "company_context_mismatch" | "company_not_allowed";
}

const CONTRIBUTION_TOOLS: ContributionTool[] = ["github.push", "github.pr.create"];

function deniedContributionAccess(reason: NonNullable<ContributionAccess["reason"]>): ContributionAccess {
  return {
    allowed: false,
    deniedTools: [...CONTRIBUTION_TOOLS],
    reason,
  };
}

export function resolveContributionAccess(
  config: BotIdentityPluginConfig,
  context: RequestContext,
): ContributionAccess {
  const alias = context.identityAlias ?? config.defaultIdentityAlias;
  const identity = alias ? config.identities?.[alias] : undefined;

  if (!identity) {
    return deniedContributionAccess("identity_missing");
  }

  if (!context.companyId) {
    return deniedContributionAccess("company_context_missing");
  }

  if (identity.companyId !== context.companyId) {
    return deniedContributionAccess("company_context_mismatch");
  }

  if (config.allowedCompanyIds && !config.allowedCompanyIds.includes(context.companyId)) {
    return deniedContributionAccess("company_not_allowed");
  }

  return {
    allowed: true,
    deniedTools: [],
    identity,
  };
}
