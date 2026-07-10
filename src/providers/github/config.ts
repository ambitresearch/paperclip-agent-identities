import { z, type ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity as CoreResolvedAgentIdentity } from "../../core/agent-identity.js";
import type { GitHubAgentIdentityConfig } from "../../core/identity-config.js";

export const githubIdentitySchema = z.object({
  label: z.string().trim().min(1),
  githubUsername: z.string().trim().min(1),
  commitName: z.string().trim().min(1).optional(),
  commitEmail: z.string().trim().min(1).optional()
});

const pluginConfigSchema = z.object({
  identities: z.record(z.string().trim().min(1), githubIdentitySchema)
});

type ParsedGitHubAgentIdentity = z.infer<typeof githubIdentitySchema>;
type ParsedGitHubBotIdentityPluginConfig = z.infer<typeof pluginConfigSchema>;

export type GitHubAgentIdentity = ParsedGitHubAgentIdentity;

export type GitHubBotIdentityPluginConfig = {
  identities: Record<string, GitHubAgentIdentity>;
};

export type ResolvedAgentIdentity = CoreResolvedAgentIdentity<GitHubAgentIdentity>;

export function parseGitHubBotIdentityPluginConfig(rawConfig: unknown): GitHubBotIdentityPluginConfig {
  return normalizePluginConfig(pluginConfigSchema.parse(rawConfig));
}

export function resolveAgentIdentityFromToolRunContext(
  rawConfig: unknown,
  runContext: ToolRunContext
): ResolvedAgentIdentity {
  const parsed = pluginConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(
      `Invalid agent identity config: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }

  const config = normalizePluginConfig(parsed.data);
  const identity = config.identities[runContext.agentId];
  if (!identity) {
    throw new Error(
      `Missing agent identity config for agent '${runContext.agentId}'. Expected identities.${runContext.agentId}.`
    );
  }

  return { agentId: runContext.agentId, identity };
}

function normalizePluginConfig(config: ParsedGitHubBotIdentityPluginConfig): GitHubBotIdentityPluginConfig {
  const identities: Record<string, GitHubAgentIdentity> = {};
  for (const [agentId, identity] of Object.entries(config.identities)) {
    identities[agentId] = identity;
  }
  return { identities };
}

export function projectGitHubPluginConfig(
  identities: Record<string, unknown>,
): Record<string, GitHubAgentIdentity> {
  const projected: Record<string, GitHubAgentIdentity> = {};
  for (const entry of Object.values(identities)) {
    if (!isGitHubIdentityConfig(entry)) continue;
    projected[entry.agentId] = toGitHubAgentIdentity(entry);
  }
  return projected;
}

function isGitHubIdentityConfig(value: unknown): value is GitHubAgentIdentityConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { provider?: unknown; github?: unknown };
  return (
    candidate.provider === "github" &&
    typeof candidate.github === "object" &&
    candidate.github !== null
  );
}

function toGitHubAgentIdentity(config: GitHubAgentIdentityConfig): GitHubAgentIdentity {
  const identity: GitHubAgentIdentity = {
    label: config.label,
    githubUsername: config.github.username,
  };
  if (config.github.commitName) identity.commitName = config.github.commitName;
  if (config.github.commitEmail) identity.commitEmail = config.github.commitEmail;
  return identity;
}
