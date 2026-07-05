import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

export type BotIdentityConfig = {
  agentId: string;
  label: string;
  githubUsername: string;
  tokenSecretRef: string;
  allowedOwnerPattern: string;
  commitName?: string;
  commitEmail?: string;
};

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
        allowedOwnerPattern: allowedOwnerPattern || "^roshangautam$",
        commitName: commitName || undefined,
        commitEmail: commitEmail || undefined,
      };

      await ctx.state.set(CONFIG_SCOPE, config);
      ctx.logger.info("Bot identity config saved", { agentId, label, githubUsername });
      return config;
    });
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
