import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createGithubBotPushBranchTool } from "./github-bot-push-branch.js";
import {
  GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  githubBotPushBranchToolDefinition
} from "./github-bot-push-branch-tool-definition.js";
import { resolveAgentIdentityFromToolRunContext } from "./identity-policy.js";
import { DEFAULT_ALLOWED_OWNER_PATTERN } from "./shared/types.js";
import type { BotIdentityConfig } from "./shared/types.js";
import { githubBotWhoamiToolMetadata, githubBotWhoamiToolName } from "./shared/github-bot-whoami-tool.js";
import { registerCreatePullRequestTool } from "./tools/create-pull-request.js";

export type { BotIdentityConfig } from "./shared/types.js";
export { DEFAULT_ALLOWED_OWNER_PATTERN } from "./shared/types.js";

const CONFIG_STATE_KEY = "bot-identity-config";
const CONFIG_SCOPE = { scopeKind: "instance" as const, stateKey: CONFIG_STATE_KEY };

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      const issueId = event.entityId ?? "unknown";
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "seen" }, true);
      ctx.logger.info("Observed issue.created", { issueId });
    });

    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    ctx.data.register("bot-identity-config", async () => {
      const config = await ctx.state.get(CONFIG_SCOPE);
      return (config as BotIdentityConfig | null) ?? null;
    });

    ctx.actions.register("ping", async () => {
      ctx.logger.info("Ping action invoked");
      return { pong: true, at: new Date().toISOString() };
    });

    ctx.tools.register(GITHUB_BOT_PUSH_BRANCH_TOOL_NAME, githubBotPushBranchToolDefinition, createGithubBotPushBranchTool(ctx));

    ctx.actions.register("save-bot-identity-config", async (params) => {
      const { agentId, label, githubUsername, tokenSecretRef, allowedOwnerPattern, commitName, commitEmail } = params as BotIdentityConfig;

      if (!agentId || !label || !githubUsername || !tokenSecretRef) {
        throw new Error("Required fields: agentId, label, githubUsername, tokenSecretRef");
      }

      const config: BotIdentityConfig = {
        agentId,
        label,
        githubUsername,
        tokenSecretRef,
        allowedOwnerPattern: allowedOwnerPattern || DEFAULT_ALLOWED_OWNER_PATTERN,
        commitName: commitName || undefined,
        commitEmail: commitEmail || undefined,
      };

      await ctx.state.set(CONFIG_SCOPE, config);
      ctx.logger.info("Bot identity config saved", { agentId, label, githubUsername });
      return config;
    });

    ctx.tools.register(githubBotWhoamiToolName, githubBotWhoamiToolMetadata, async (_params, runCtx) => {
      let resolved;
      try {
        resolved = resolveAgentIdentityFromToolRunContext(await ctx.config.get(), runCtx);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown identity resolution failure";
        return {
          error: `github_bot_whoami failed closed for agent '${runCtx.agentId}' in company '${runCtx.companyId}': ${message}`
        };
      }

      const { identity } = resolved;
      return {
        content: `Configured GitHub bot identity: ${identity.label} (@${identity.githubUsername}).`,
        data: {
          label: identity.label,
          githubUsername: identity.githubUsername,
          allowedOwners: identity.allowedOwnerPatterns,
          allowedRepos: identity.allowedRepos ?? [],
          hasCommitName: Boolean(identity.commitName),
          hasCommitEmail: Boolean(identity.commitEmail)
        }
      };
    });

    registerCreatePullRequestTool(ctx);
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
