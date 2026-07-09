import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { resolveAgentIdentityFromToolRunContext, type GitHubBotIdentityPluginConfig, type ResolvedAgentIdentity } from "./identity-policy.js";
import { GITHUB_IDENTITY_PROVIDER_ID, getIdentityKey, isIdentityProviderId, type BotIdentityConfig, type BotIdentitySettingsState, type IdentityProviderId } from "./shared/types.js";

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
  if (isRecord(rawConfig) && rawConfig.version === 3 && isRecord(rawConfig.identities)) {
    const identities: Record<string, BotIdentityConfig> = {};
    for (const [identityKey, rawIdentity] of Object.entries(rawConfig.identities)) {
      const identity = normalizeBotIdentityConfig(rawIdentity, identityKey);
      if (identity) {
        identities[identity.id] = identity;
      }
    }
    return { version: 3, identities };
  }

  return { version: 3, identities: {} };
}

export function botIdentityStateToPluginConfig(state: BotIdentitySettingsState): GitHubBotIdentityPluginConfig {
  const identities: GitHubBotIdentityPluginConfig["identities"] = {};
  for (const identity of Object.values(state.identities)) {
    if (identity.provider !== GITHUB_IDENTITY_PROVIDER_ID) continue;
    identities[identity.agentId] = {
      label: identity.label,
      githubUsername: identity.githubUsername,
      commitName: identity.commitName || undefined,
      commitEmail: identity.commitEmail || undefined,
    };
  }
  return { identities };
}

function normalizeBotIdentityConfig(rawConfig: unknown, fallbackIdentityKey?: string): BotIdentityConfig | null {
  if (!isRecord(rawConfig)) return null;

  const provider = readProvider(rawConfig.provider);
  if (!provider) return null;
  const agentId = readString(rawConfig.agentId) || readAgentIdFromIdentityKey(fallbackIdentityKey, provider);
  const label = readString(rawConfig.label);
  const githubUsername = readString(rawConfig.githubUsername);
  if (!agentId || !label || !githubUsername) return null;

  const id = getIdentityKey(agentId, provider);
  return {
    id,
    agentId,
    provider,
    label,
    githubUsername,
    githubAppCredentialPropagationAgentIds:
      readStringArray(rawConfig.githubAppCredentialPropagationAgentIds) ?? readStringArray(rawConfig.githubTokenPropagationAgentIds),
    commitName: readString(rawConfig.commitName) || undefined,
    commitEmail: readString(rawConfig.commitEmail) || undefined,
  };
}

function readProvider(value: unknown): IdentityProviderId | null {
  const provider = readString(value);
  return isIdentityProviderId(provider) ? provider : null;
}

function readAgentIdFromIdentityKey(identityKey: string | undefined, provider: IdentityProviderId): string {
  const suffix = `:${provider}`;
  const key = identityKey?.trim() ?? "";
  return key.endsWith(suffix) ? key.slice(0, -suffix.length) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value
    .map((entry) => readString(entry))
    .filter(Boolean);
  return strings.length > 0 ? strings : undefined;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
