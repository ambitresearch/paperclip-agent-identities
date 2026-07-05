import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createGithubBotPushBranchTool } from "./githubBotPushBranch.js";

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

    ctx.actions.register("ping", async () => {
      ctx.logger.info("Ping action invoked");
      return { pong: true, at: new Date().toISOString() };
    });

    ctx.tools.register(
      "github_bot_push_branch",
      {
        displayName: "Push Branch",
        description: "Push HEAD to a branch on an allowed GitHub repository through mediated credentials.",
        parametersSchema: {
          type: "object",
          additionalProperties: false,
          required: ["branch"],
          properties: {
            branch: { type: "string", minLength: 1 },
            remote: { type: "string" },
            expectedRepository: { type: "string" },
            dryRun: { type: "boolean" }
          }
        }
      },
      createGithubBotPushBranchTool(ctx)
    );
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
