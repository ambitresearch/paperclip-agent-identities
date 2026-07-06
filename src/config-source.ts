import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { resolveAgentIdentityFromToolRunContext, type GitHubBotIdentityPluginConfig, type ResolvedAgentIdentity } from "./identity-policy.js";
import { DEFAULT_ALLOWED_OWNER_PATTERN, type BotIdentityConfig } from "./shared/types.js";

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

    const fallbackConfig = botIdentityStateToPluginConfig(stateConfig as BotIdentityConfig);
    try {
      return resolveAgentIdentityFromToolRunContext(fallbackConfig, runCtx);
    } catch (fallbackError) {
      const primaryReason = instanceConfigError instanceof Error ? instanceConfigError.message : String(instanceConfigError);
      const fallbackReason = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(`${primaryReason}; settings-page fallback failed: ${fallbackReason}`);
    }
  }
}

function botIdentityStateToPluginConfig(config: BotIdentityConfig): GitHubBotIdentityPluginConfig {
  const allowedOwnerPattern = config.allowedOwnerPattern?.trim() || DEFAULT_ALLOWED_OWNER_PATTERN;
  return {
    identities: {
      [config.agentId]: {
        label: config.label,
        githubUsername: config.githubUsername,
        allowedOwnerPatterns: [allowedOwnerPattern],
        commitName: config.commitName || undefined,
        commitEmail: config.commitEmail || undefined,
      },
    },
  };
}
