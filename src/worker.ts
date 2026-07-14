import {
  definePlugin, runWorker, type PluginContext, type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { CONFIG_SCOPE } from "./config-source.js";
import {
  getIdentityKey, getIdentityProviderDefinition, isIdentityProviderId,
  SUPPORTED_IDENTITY_PROVIDERS, type BotIdentityCredentialConfig,
  type BotIdentitySettingsData, type BotIdentitySettingsEntry,
  type DeleteBotIdentityConfigInput, type IdentityProviderId,
  type PaperclipAgentOption, type PaperclipAgentsData,
  type SaveBotIdentityConfigInput,
} from "./shared/types.js";
import { resolveAgentIdentity, type ResolvedAgentIdentity } from "./core/agent-identity.js";
import {
  BOT_IDENTITY_SETTINGS_VERSION,
  normalizeSettingsState,
  type AgentIdentitySettingsState,
  type GitHubAgentIdentityConfig,
} from "./core/identity-config.js";
import type { IdentityProvider } from "./core/provider-contract.js";
import type { ResourceReference } from "./core/resource-reference.js";
import { createProviderTool, type ProviderToolPipelineDeps } from "./core/tool-pipeline.js";
import { redactSecrets } from "./lib/redaction.js";
import { createProviderRegistry } from "./providers/index.js";
import {
  deleteCredentialSidecarIdentity,
  readCredentialSidecarIfExists,
  resolveCredentialSidecarPath,
  upsertCredentialSidecarIdentity,
  type CredentialSidecarIdentity,
  type GitHubBotIdentityCredentialSidecar
} from "./credential-sidecar.js";
export type { BotIdentityConfig } from "./shared/types.js";

// `onWebhook` (a sibling PluginDefinition hook, not nested inside `setup`) needs
// the same `PluginContext` `setup` received to read state/secrets/agents. The
// SDK does not pass `ctx` to `onWebhook` directly, so it is captured here —
// safe because the host guarantees `setup` completes (and thus this is
// assigned) before any webhook can be routed to this worker process.
let capturedCtx: PluginContext | undefined;

const plugin = definePlugin({
  async setup(ctx) {
    capturedCtx = ctx;
    ctx.events.on("issue.created", async (event) => {
      const issueId = event.entityId ?? "unknown";
      await ctx.state.set({ scopeKind: "issue", scopeId: issueId, stateKey: "seen" }, true);
      ctx.logger.info("Observed issue.created", { issueId });
    });

    ctx.data.register("health", async () => {
      return { status: "ok", checkedAt: new Date().toISOString() };
    });

    ctx.data.register("bot-identity-config", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      const state = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
      return await buildSettingsData(ctx, state, companyId);
    });

    ctx.data.register("paperclip-agents", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      if (!companyId) {
        return { agents: [] } satisfies PaperclipAgentsData;
      }

      const agents = await listCompanyAgentOptions(ctx, companyId);
      return { agents } satisfies PaperclipAgentsData;
    });

    ctx.actions.register("ping", async () => {
      ctx.logger.info("Ping action invoked");
      return { pong: true, at: new Date().toISOString() };
    });

    const registry = createProviderRegistry();
    // `liveTools()` composes every tool that should actually register right
    // now: all tools from "enabled" providers, PLUS any individual tool a
    // "coming-soon" provider marks `live: true` (e.g. Slack's credential-free
    // `slack_bot_whoami` self-check, DRO-972, ahead of the rest of that
    // provider's surface). This loop stays provider-agnostic -- no
    // provider-specific branch is added here.
    for (const { provider, tool: toolSpec } of registry.liveTools()) {
      const deps: ProviderToolPipelineDeps<unknown> = {
        resolveIdentity: async (toolCtx, runCtx) =>
          await resolveIdentityForProvider(provider, toolCtx, runCtx),
        redactSecrets,
      };
      const registered = createProviderTool(provider, toolSpec, ctx, deps);
      ctx.tools.register(
        registered.name,
        registered.metadata as Parameters<typeof ctx.tools.register>[1],
        registered.handler as Parameters<typeof ctx.tools.register>[2],
      );
    }
    // contributeActions is composed for EVERY registered provider, not just
    // "enabled" ones: a "coming-soon" provider (no tools yet) can still ship
    // setup/bootstrap actions (e.g. Slack's manifest-assisted app setup) ahead
    // of its tool surface landing. This loop stays provider-agnostic — no
    // provider-specific branch is added here.
    for (const provider of registry.all()) {
      provider.contributeActions?.(ctx);
    }

    ctx.actions.register("save-bot-identity-config", async (params) => {
      const input = params as SaveBotIdentityConfigInput;
      const identity = normalizeIdentityInput(input);
      const previousState = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
      const previousAgentId = typeof input.previousAgentId === "string" ? input.previousAgentId.trim() : "";
      const previousIdentityKey = previousAgentId && previousAgentId !== identity.agentId
        ? getIdentityKey(previousAgentId, identity.provider)
        : "";
      const nextIdentities = { ...previousState.identities };
      if (previousIdentityKey) {
        delete nextIdentities[previousIdentityKey];
      }
      nextIdentities[identity.id] = identity;
      const nextState: AgentIdentitySettingsState = {
        version: BOT_IDENTITY_SETTINGS_VERSION,
        identities: nextIdentities,
      };

      await ctx.state.set(CONFIG_SCOPE, nextState);
      const credential = normalizeCredentialInput(input.credential);
      if (previousAgentId && previousAgentId !== identity.agentId) {
        await deleteCredentialSidecarIdentity(previousAgentId, identity.provider);
      }
      if (input.credential !== undefined) {
        if (credential) {
          await upsertCredentialSidecarIdentity(identity.agentId, identity.provider, credential);
        } else {
          await deleteCredentialSidecarIdentity(identity.agentId, identity.provider);
        }
      }

      ctx.logger.info("Agent identity config saved", { agentId: identity.agentId, provider: identity.provider, label: identity.label, githubUsername: identity.github.username });
      return (await buildSettingsData(ctx, nextState)).identities.find((entry) => entry.id === identity.id) ?? identity;
    });

    ctx.actions.register("delete-bot-identity-config", async (params) => {
      const input = params as DeleteBotIdentityConfigInput;
      const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
      const provider = normalizeProviderInput(input.provider);
      if (!agentId) {
        throw new Error("agentId is required");
      }
      const identityKey = getIdentityKey(agentId, provider);

      const previousState = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
      const { [identityKey]: _removed, ...identities } = previousState.identities;
      const nextState: AgentIdentitySettingsState = { version: BOT_IDENTITY_SETTINGS_VERSION, identities };
      await ctx.state.set(CONFIG_SCOPE, nextState);
      await deleteCredentialSidecarIdentity(agentId, provider);
      ctx.logger.info("Agent identity config deleted", { agentId, provider });
      return await buildSettingsData(ctx, nextState);
    });
  },

  async onHealth() {
    return { status: "ok", message: "Plugin worker is running" };
  },

  async onWebhook(input) {
    if (!capturedCtx) {
      // Should be unreachable in practice (see the `capturedCtx` comment
      // above) — fail loud rather than silently drop a webhook delivery.
      throw new Error("Webhook received before plugin setup completed");
    }
    const ctx = capturedCtx;

    // Dispatch generically by matching `endpointKey` against every provider's
    // declared webhook endpoints -- no provider-specific branch here. See
    // `ProviderRegistry.webhooks()` / `IdentityProvider.handleWebhook`.
    const registry = createProviderRegistry();
    const matched = registry.webhooks().find(({ declaration }) => declaration.endpointKey === input.endpointKey);
    if (!matched) {
      ctx.logger.warn("Webhook received for unknown endpointKey", { endpointKey: input.endpointKey });
      return;
    }

    await matched.provider.handleWebhook?.(input, ctx);
  }
});

export default plugin;
runWorker(plugin, import.meta.url);

async function resolveIdentityForProvider<TIdentity>(
  provider: IdentityProvider<TIdentity, ResourceReference>,
  ctx: PluginContext,
  runCtx: ToolRunContext,
): Promise<ResolvedAgentIdentity<TIdentity>> {
  const instanceConfig = await ctx.config.get();
  const validated = provider.validateConfig(readInstanceIdentity(instanceConfig, runCtx.agentId));
  if (typeof validated !== "string") {
    return { agentId: runCtx.agentId, identity: validated };
  }

  const primaryReason = validated;
  const stateConfig = await ctx.state.get(CONFIG_SCOPE);
  if (!stateConfig) throw new Error(primaryReason);

  const projected = provider.projectPluginConfig(normalizeSettingsState(stateConfig).identities);
  try {
    return resolveAgentIdentity({ identities: projected }, runCtx);
  } catch (error) {
    const fallbackReason = error instanceof Error ? error.message : String(error);
    throw new Error(`${primaryReason}; settings-page fallback failed: ${fallbackReason}`);
  }
}

function readInstanceIdentity(config: unknown, agentId: string): unknown {
  if (!isRecord(config) || !isRecord(config.identities)) return undefined;
  return config.identities[agentId];
}

async function buildSettingsData(ctx: PluginContext, state: AgentIdentitySettingsState, companyId = ""): Promise<BotIdentitySettingsData> {
  const companyName = companyId ? await resolveCompanyName(ctx, companyId) : "";
  const credentialSidecarPath = await resolveCredentialSidecarPath();
  let sidecar: GitHubBotIdentityCredentialSidecar | null = null;
  let credentialSidecarError: string | undefined;
  try {
    sidecar = await readCredentialSidecarIfExists(credentialSidecarPath);
  } catch (error) {
    credentialSidecarError = error instanceof Error ? error.message : String(error);
  }

  const companyAgents = companyId ? await listCompanyAgentOptions(ctx, companyId) : [];
  const companyAgentIds = companyId && companyAgents.length > 0
    ? new Set(companyAgents.map((agent) => agent.id))
    : null;

  const identities: BotIdentitySettingsEntry[] = Object.values(state.identities)
    .filter((identity) => !companyAgentIds || companyAgentIds.has(identity.agentId))
    .map((identity) => {
      const credential = sidecar?.identities[identity.id];
      return {
        ...identity,
        credential,
        credentialStatus: credential
          ? "configured"
          : credentialSidecarError
            ? "sidecar-unavailable"
            : "missing",
      } satisfies BotIdentitySettingsEntry;
    })
    .sort((left, right) => left.label.localeCompare(right.label));

  return {
    version: BOT_IDENTITY_SETTINGS_VERSION,
    identities,
    providers: SUPPORTED_IDENTITY_PROVIDERS,
    ...(companyName ? { companyName } : {}),
    credentialSidecarPath,
    ...(credentialSidecarError ? { credentialSidecarError } : {}),
  };
}

async function resolveCompanyName(ctx: PluginContext, companyId: string): Promise<string> {
  const company = await ctx.companies.get(companyId);
  return readString(company?.name);
}

async function listCompanyAgentOptions(ctx: PluginContext, companyId: string): Promise<PaperclipAgentOption[]> {
  const agents = await ctx.agents.list({ companyId });
  return agents
    .filter((agent) => {
      const agentCompanyId = isRecord(agent) ? readString(agent.companyId) : "";
      return !agentCompanyId || agentCompanyId === companyId;
    })
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      role: agent.role ?? null,
      title: agent.title ?? null,
      status: agent.status ?? null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeIdentityInput(input: SaveBotIdentityConfigInput): GitHubAgentIdentityConfig {
  const agentId = readRequiredString(input.agentId, "agentId");
  const provider = normalizeProviderInput(input.provider);
  const providerDefinition = getIdentityProviderDefinition(provider);
  if (providerDefinition.status !== "enabled" || provider !== "github" || input.provider !== "github") {
    throw new Error(`${providerDefinition.name} identities are not supported yet.`);
  }
  const label = readRequiredString(input.label, "label");
  if (!input.github) {
    throw new Error("Required fields: github");
  }
  const username = readRequiredString(input.github.username, "github.username");
  const id = getIdentityKey(agentId, provider);
  const commitName = readOptionalString(input.github.commitName);
  const commitEmail = readOptionalString(input.github.commitEmail);
  const propagationAgentIds = normalizeAgentIds(input.github.app?.credentialPropagationAgentIds);

  return {
    provider: "github",
    id,
    agentId,
    label,
    github: {
      username,
      ...(commitName ? { commitName } : {}),
      ...(commitEmail ? { commitEmail } : {}),
      ...(propagationAgentIds.length > 0 ? { app: { credentialPropagationAgentIds: propagationAgentIds } } : {}),
    },
  };
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text.length > 0 ? text : undefined;
}

function normalizeAgentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((agentId) => (typeof agentId === "string" ? agentId.trim() : ""))
    .filter(Boolean)
    .filter((agentId, index, entries) => entries.indexOf(agentId) === index);
}

function normalizeProviderInput(value: unknown): IdentityProviderId {
  const provider = typeof value === "string" ? value.trim() : "";
  if (!isIdentityProviderId(provider)) {
    throw new Error("provider is required and must be a supported identity provider");
  }
  return provider;
}

function normalizeCredentialInput(input: BotIdentityCredentialConfig | undefined): CredentialSidecarIdentity | null {
  if (!input) return null;
  const secretId = input.secretId?.trim();
  const tokenFile = input.tokenFile?.trim();
  const githubApp = normalizeGitHubAppCredentialInput(input.githubApp);
  if (!secretId && !tokenFile && !githubApp) return null;
  return {
    ...(secretId ? { secretId } : {}),
    ...(tokenFile ? { tokenFile } : {}),
    ...(githubApp ? { githubApp } : {}),
  };
}

function normalizeGitHubAppCredentialInput(input: BotIdentityCredentialConfig["githubApp"] | undefined): { appId: string; installationId: string; privateKeySecretId?: string; privateKeyFile?: string } | null {
  if (!input) return null;
  const appId = input.appId?.trim();
  const installationId = input.installationId?.trim();
  const privateKeySecretId = input.privateKeySecretId?.trim();
  const privateKeyFile = input.privateKeyFile?.trim();
  if (!appId && !installationId && !privateKeySecretId && !privateKeyFile) return null;
  if (!appId || !installationId || (!privateKeySecretId && !privateKeyFile)) {
    throw new Error("GitHub App credentials require appId, installationId, and a private key secret or file");
  }
  return {
    appId,
    installationId,
    ...(privateKeySecretId ? { privateKeySecretId } : {}),
    ...(privateKeyFile ? { privateKeyFile } : {}),
  };
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Required fields: ${field}`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
