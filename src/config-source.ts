import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { resolveAgentIdentityFromToolRunContext, type GitHubBotIdentityPluginConfig, type ResolvedAgentIdentity } from "./identity-policy.js";
import { DEFAULT_ALLOWED_REPO_PATTERNS, type BotIdentityConfig, type BotIdentitySettingsState } from "./shared/types.js";

export const CONFIG_STATE_KEY = "bot-identity-config";
export const CONFIG_SCOPE = { scopeKind: "instance" as const, stateKey: CONFIG_STATE_KEY };

export async function resolveAgentIdentityFromPluginSettings(
  ctx: PluginContext,
  runCtx: ToolRunContext
): Promise<ResolvedAgentIdentity> {
  const instanceConfig = await ctx.config.get();
  try {
    return resolveAgentIdentityFromToolRunContext(instanceConfig, runCtx);
  } catch (instanceConfigError) {
    const stateConfig = await ctx.state.get(CONFIG_SCOPE);
    if (!stateConfig) {
      throw instanceConfigError;
    }

    const fallbackConfig = botIdentityStateToPluginConfig(normalizeBotIdentitySettingsState(stateConfig));
    try {
      return resolveAgentIdentityFromToolRunContext(fallbackConfig, runCtx);
    } catch (fallbackError) {
      const primaryReason = instanceConfigError instanceof Error ? instanceConfigError.message : String(instanceConfigError);
      const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${primaryReason}; settings-page fallback failed: ${fallbackReason}`);
    }
  }
}

export function normalizeBotIdentitySettingsState(rawConfig: unknown): BotIdentitySettingsState {
  if (isRecord(rawConfig) && rawConfig.version === 2 && isRecord(rawConfig.identities)) {
    const identities: Record<string, BotIdentityConfig> = {};
    for (const [agentId, rawIdentity] of Object.entries(rawConfig.identities)) {
      const identity = normalizeBotIdentityConfig(rawIdentity, agentId);
      if (identity) {
        identities[identity.agentId] = identity;
      }
    }
    return { version: 2, identities };
  }

  const legacyIdentity = normalizeBotIdentityConfig(rawConfig);
  return {
    version: 2,
    identities: legacyIdentity ? { [legacyIdentity.agentId]: legacyIdentity } : {},
  };
}

export function botIdentityStateToPluginConfig(state: BotIdentitySettingsState): GitHubBotIdentityPluginConfig {
  const identities: GitHubBotIdentityPluginConfig["identities"] = {};
  for (const identity of Object.values(state.identities)) {
    identities[identity.agentId] = {
      label: identity.label,
      githubUsername: identity.githubUsername,
      allowedRepoPatterns: normalizeAllowedRepoPatterns(identity.allowedRepoPatterns),
      commitName: identity.commitName || undefined,
      commitEmail: identity.commitEmail || undefined,
    };
  }
  return { identities };
}

function normalizeBotIdentityConfig(rawConfig: unknown, fallbackAgentId?: string): BotIdentityConfig | null {
  if (!isRecord(rawConfig)) return null;

  const agentId = readString(rawConfig.agentId) || fallbackAgentId?.trim() || "";
  const label = readString(rawConfig.label);
  const githubUsername = readString(rawConfig.githubUsername);
  if (!agentId || !label || !githubUsername) return null;

  return {
    agentId,
    label,
    githubUsername,
    allowedRepoPatterns: readAllowedRepoPatterns(rawConfig),
    githubAppCredentialPropagationAgentIds:
      readStringArray(rawConfig.githubAppCredentialPropagationAgentIds) ?? readStringArray(rawConfig.githubTokenPropagationAgentIds),
    commitName: readString(rawConfig.commitName) || undefined,
    commitEmail: readString(rawConfig.commitEmail) || undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readAllowedRepoPatterns(rawConfig: Record<string, unknown>): string[] {
  const explicitPatterns = readStringArray(rawConfig.allowedRepoPatterns);
  if (explicitPatterns !== undefined) {
    return explicitPatterns;
  }

  const allowedRepos = readStringArray(rawConfig.allowedRepos);
  if (allowedRepos !== undefined && allowedRepos.length > 0) {
    return allowedRepos;
  }

  const ownerPattern = readString(rawConfig.allowedOwnerPattern);
  if (ownerPattern) {
    return legacyOwnerPatternsToRepoPatterns([ownerPattern]);
  }

  const ownerPatterns = readStringArray(rawConfig.allowedOwnerPatterns);
  if (ownerPatterns !== undefined) {
    return legacyOwnerPatternsToRepoPatterns(ownerPatterns);
  }

  return [...DEFAULT_ALLOWED_REPO_PATTERNS];
}

function legacyOwnerPatternsToRepoPatterns(ownerPatterns: string[]): string[] {
  const converted = ownerPatterns
    .map((pattern) => exactLegacyOwnerPatternToRepoPattern(pattern))
    .filter((pattern): pattern is string => Boolean(pattern));
  return normalizeAllowedRepoPatterns(converted);
}

function exactLegacyOwnerPatternToRepoPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  const exactMatch = trimmed.match(/^\^?([a-zA-Z0-9][a-zA-Z0-9-]*)\$?$/);
  return exactMatch ? `${exactMatch[1].toLowerCase()}/*` : null;
}

function normalizeAllowedRepoPatterns(values: readonly string[] | undefined): string[] {
  const entries = values?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  return entries.filter((entry, index) => entries.indexOf(entry) === index);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return normalizeAllowedRepoPatterns(value.map((entry) => readString(entry)));
}
