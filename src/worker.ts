import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { githubBotWhoamiToolMetadata, githubBotWhoamiToolName } from "./shared/github-bot-whoami-tool.js";

type AgentIdentityConfig = {
  companyId: string;
  agentId: string;
  label: string;
  githubUsername: string;
  allowedOwners: string[];
  allowedRepos: string[];
  commitName?: string;
  commitEmail?: string;
};

const asString = (value: unknown): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value.map(asString).filter((entry): entry is string => Boolean(entry));
  return normalized.length === value.length ? normalized : undefined;
};

const resolveAgentIdentities = (config: unknown): AgentIdentityConfig[] => {
  if (!config || typeof config !== "object") {
    return [];
  }

  const identitiesRaw = (config as { agentIdentities?: unknown }).agentIdentities;
  if (!Array.isArray(identitiesRaw)) {
    return [];
  }

  const identities: AgentIdentityConfig[] = [];
  for (const entry of identitiesRaw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const companyId = asString(record.companyId);
    const agentId = asString(record.agentId);
    const label = asString(record.label);
    const githubUsername = asString(record.githubUsername);
    const allowedOwners = asStringArray(record.allowedOwners);
    const allowedRepos = asStringArray(record.allowedRepos);

    if (!companyId || !agentId || !label || !githubUsername || !allowedOwners || !allowedRepos) {
      continue;
    }

    identities.push({
      companyId,
      agentId,
      label,
      githubUsername,
      allowedOwners,
      allowedRepos,
      commitName: asString(record.commitName),
      commitEmail: asString(record.commitEmail)
    });
  }

  return identities;
};

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

    ctx.tools.register(githubBotWhoamiToolName, githubBotWhoamiToolMetadata, async (_params, runCtx) => {
      const identities = resolveAgentIdentities(await ctx.config.get());
      const identity = identities.find((entry) => entry.agentId === runCtx.agentId && entry.companyId === runCtx.companyId);

      if (!identity) {
        return {
          error: `github_bot_whoami is not configured for agent ${runCtx.agentId} in company ${runCtx.companyId}.`
        };
      }

      const safeSummary = {
        label: identity.label,
        githubUsername: identity.githubUsername,
        allowedOwners: identity.allowedOwners,
        allowedRepos: identity.allowedRepos,
        hasCommitName: Boolean(identity.commitName),
        hasCommitEmail: Boolean(identity.commitEmail)
      };

      return {
        content: `Configured GitHub bot identity: ${identity.label} (@${identity.githubUsername}).`,
        data: safeSummary
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
