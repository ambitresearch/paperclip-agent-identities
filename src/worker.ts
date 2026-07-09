import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createGithubBotPushBranchTool } from "./github-bot-push-branch.js";
import {
  GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  githubBotPushBranchToolDefinition
} from "./github-bot-push-branch-tool-definition.js";
import {
  CONFIG_SCOPE,
  normalizeBotIdentitySettingsState,
  resolveAgentIdentityFromPluginSettings
} from "./config-source.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GITHUB_IDENTITY_PROVIDER_ID, SUPPORTED_IDENTITY_PROVIDERS, getIdentityKey, getIdentityProviderDefinition, isIdentityProviderId, type IdentityProviderId } from "./shared/types.js";
import type {
  BotIdentityConfig,
  BotIdentityCredentialConfig,
  BotIdentitySettingsData,
  BotIdentitySettingsEntry,
  BotIdentitySettingsState,
  DeleteBotIdentityConfigInput,
  CreateGitHubAppManifestInput,
  CreateGitHubAppManifestResult,
  ConvertGitHubAppManifestInput,
  ConvertGitHubAppManifestResult,
  GetGitHubAppManifestFlowInput,
  GitHubAppManifestFlowState,
  PaperclipAgentOption,
  PaperclipAgentsData,
  SaveBotIdentityConfigInput
} from "./shared/types.js";
import {
  deleteCredentialSidecarIdentity,
  readCredentialSidecarIfExists,
  resolveCredentialSidecarPath,
  upsertCredentialSidecarIdentity,
  type CredentialSidecarIdentity,
  type GitHubBotIdentityCredentialSidecar
} from "./credential-sidecar.js";
import { githubBotWhoamiToolMetadata, githubBotWhoamiToolName } from "./shared/github-bot-whoami-tool.js";
import { registerCreatePullRequestTool } from "./tools/create-pull-request.js";

export type { BotIdentityConfig } from "./shared/types.js";

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

    ctx.data.register("bot-identity-config", async (params) => {
      const companyId = typeof params.companyId === "string" ? params.companyId.trim() : "";
      const state = normalizeBotIdentitySettingsState(await ctx.state.get(CONFIG_SCOPE));
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

    ctx.tools.register(GITHUB_BOT_PUSH_BRANCH_TOOL_NAME, githubBotPushBranchToolDefinition, createGithubBotPushBranchTool(ctx));

    ctx.actions.register("save-bot-identity-config", async (params) => {
      const input = params as SaveBotIdentityConfigInput;
      const identity = normalizeIdentityInput(input);
      const previousState = normalizeBotIdentitySettingsState(await ctx.state.get(CONFIG_SCOPE));
      const previousAgentId = typeof input.previousAgentId === "string" ? input.previousAgentId.trim() : "";
      const previousIdentityKey = previousAgentId && previousAgentId !== identity.agentId
        ? getIdentityKey(previousAgentId, identity.provider)
        : "";
      const nextIdentities = { ...previousState.identities };
      if (previousIdentityKey) {
        delete nextIdentities[previousIdentityKey];
      }
      nextIdentities[identity.id] = identity;
      const nextState: BotIdentitySettingsState = {
        version: 3,
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

      ctx.logger.info("Agent identity config saved", { agentId: identity.agentId, provider: identity.provider, label: identity.label, githubUsername: identity.githubUsername });
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

      const previousState = normalizeBotIdentitySettingsState(await ctx.state.get(CONFIG_SCOPE));
      const { [identityKey]: _removed, ...identities } = previousState.identities;
      const nextState: BotIdentitySettingsState = { version: 3, identities };
      await ctx.state.set(CONFIG_SCOPE, nextState);
      await deleteCredentialSidecarIdentity(agentId, provider);
      ctx.logger.info("Agent identity config deleted", { agentId, provider });
      return await buildSettingsData(ctx, nextState);
    });


    ctx.actions.register("create-github-app-manifest", async (params) => {
      const result = createGitHubAppManifestFlow(params as CreateGitHubAppManifestInput);
      await ctx.state.set(githubAppManifestFlowScope(result.state), result);
      ctx.logger.info("GitHub App manifest flow created", { agentId: result.agentId, appName: result.appName });
      return result;
    });

    ctx.actions.register("get-github-app-manifest-flow", async (params) => {
      const input = params as GetGitHubAppManifestFlowInput;
      const state = readRequiredString(input.state, "state");
      const flow = normalizeGitHubAppManifestFlowState(await ctx.state.get(githubAppManifestFlowScope(state)));
      if (!flow || flow.state !== state) {
        throw new Error("Unknown or expired GitHub App manifest flow state.");
      }
      return flow;
    });

    ctx.actions.register("convert-github-app-manifest", async (params) => {
      const input = params as ConvertGitHubAppManifestInput;
      const state = readRequiredString(input.state, "state");
      const code = readRequiredString(input.code, "code");
      const flow = normalizeGitHubAppManifestFlowState(await ctx.state.get(githubAppManifestFlowScope(state)));
      if (!flow || flow.state !== state) {
        throw new Error("Unknown or expired GitHub App manifest flow state.");
      }

      const response = await ctx.http.fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "paperclip-agent-identities/github-app-manifest",
          "x-github-api-version": "2022-11-28",
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub App manifest conversion failed: ${response.status} ${await response.text()}`);
      }

      const conversion = await response.json();
      const converted = await persistGitHubAppManifestConversion(flow, conversion);
      await ctx.state.delete(githubAppManifestFlowScope(flow.state));
      ctx.logger.info("GitHub App manifest converted", { agentId: converted.agentId, appId: converted.appId, appSlug: converted.appSlug });
      return converted;
    });

    ctx.tools.register(githubBotWhoamiToolName, githubBotWhoamiToolMetadata, async (_params, runCtx) => {
      let resolved;
      try {
        resolved = await resolveAgentIdentityFromPluginSettings(ctx, runCtx);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown identity resolution failure";
        return {
          error: `github_bot_whoami failed closed for agent '${runCtx.agentId}' in company '${runCtx.companyId}': ${message}`
        };
      }

      const { identity } = resolved;
      return {
        content: `Configured GitHub identity: ${identity.label} (@${identity.githubUsername}).`,
        data: {
          label: identity.label,
          githubUsername: identity.githubUsername,
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

async function buildSettingsData(ctx: PluginContext, state: BotIdentitySettingsState, companyId = ""): Promise<BotIdentitySettingsData> {
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
    version: 3,
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

function normalizeIdentityInput(input: SaveBotIdentityConfigInput): BotIdentityConfig {
  const agentId = readRequiredString(input.agentId, "agentId");
  const provider = normalizeProviderInput(input.provider);
  const providerDefinition = getIdentityProviderDefinition(provider);
  if (providerDefinition.status !== "enabled") {
    throw new Error(`${providerDefinition.name} identities are not supported yet.`);
  }
  const label = readRequiredString(input.label, "label");
  const githubUsername = readRequiredString(input.githubUsername, "githubUsername");
  const id = getIdentityKey(agentId, provider);
  return {
    id,
    agentId,
    provider,
    label,
    githubUsername,
    githubAppCredentialPropagationAgentIds: Array.isArray(input.githubAppCredentialPropagationAgentIds)
      ? input.githubAppCredentialPropagationAgentIds.map((agentId) => agentId.trim()).filter(Boolean).filter((agentId, index, entries) => entries.indexOf(agentId) === index)
      : [],
    commitName: input.commitName?.trim() || undefined,
    commitEmail: input.commitEmail?.trim() || undefined,
  };
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

function readProvider(value: unknown): IdentityProviderId | null {
  const provider = readString(value);
  return isIdentityProviderId(provider) ? provider : null;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Required fields: ${field}`);
  }
  return value.trim();
}

function validateSinglePathSegment(value: string, field: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) {
    throw new Error(`${field} must be a single path segment.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const GITHUB_APP_MANIFEST_FLOW_STATE_PREFIX = "github-app-manifest-flow:";
const DEFAULT_GITHUB_APP_URL = "https://paperclip.example.com";

function githubAppManifestFlowScope(state: string) {
  return { scopeKind: "instance" as const, stateKey: `${GITHUB_APP_MANIFEST_FLOW_STATE_PREFIX}${state}` };
}

function createGitHubAppManifestFlow(input: CreateGitHubAppManifestInput): CreateGitHubAppManifestResult {
  const agentId = validateSinglePathSegment(readRequiredString(input.agentId, "agentId"), "agentId");
  const provider = input.provider ? normalizeProviderInput(input.provider) : GITHUB_IDENTITY_PROVIDER_ID;
  if (provider !== GITHUB_IDENTITY_PROVIDER_ID) {
    throw new Error("GitHub App manifest flow only supports the GitHub provider.");
  }
  const label = readRequiredString(input.label, "label");
  const callbackUrl = readOptionalUrl(input.callbackUrl, "callbackUrl") ?? DEFAULT_GITHUB_APP_URL;
  const homepageUrl = readOptionalUrl(input.homepageUrl, "homepageUrl") ?? callbackUrl;
  const appName = normalizeGitHubAppName(label);
  const state = `pc_${createHash("sha256").update(`${agentId}:${provider}:${Date.now()}:${randomBytes(16).toString("hex")}`).digest("hex").slice(0, 32)}`;
  const setupUrl = getGitHubAppSetupUrl(callbackUrl, state);
  const manifest = JSON.stringify({
    name: appName,
    description: `Paperclip-managed GitHub App identity provider for ${label}.`,
    url: homepageUrl,
    redirect_url: callbackUrl,
    callback_urls: [callbackUrl],
    setup_url: setupUrl,
    setup_on_update: true,
    request_oauth_on_install: false,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      workflows: "write",
    },
    default_events: [],
  });

  return {
    agentId,
    provider,
    state,
    manifest,
    postUrl: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
    setupUrl,
    createdAt: new Date().toISOString(),
    label,
    appName,
  };
}

function normalizeGitHubAppName(label: string): string {
  const base = label.replace(/\[[^\]]*\]/g, "").replace(/[^a-zA-Z0-9 -]/g, " ").replace(/\s+/g, " ").trim();
  const name = base.toLowerCase().includes("paperclip") ? base : `${base} Paperclip Agent`;
  return name.slice(0, 34).replace(/\s+$/g, "") || "Paperclip Agent";
}

function normalizeGitHubAppManifestFlowState(raw: unknown): GitHubAppManifestFlowState | null {
  if (!isRecord(raw)) return null;
  const agentId = readString(raw.agentId);
  const provider = readProvider(raw.provider);
  const state = readString(raw.state);
  const manifest = readString(raw.manifest);
  const postUrl = readString(raw.postUrl);
  const setupUrl = readString(raw.setupUrl) || readString(parseManifestSetupUrl(manifest)) || postUrl;
  const createdAt = readString(raw.createdAt);
  const appName = readString(raw.appName) || readString(parseManifestName(manifest));
  const label = readString(raw.label) || appName;
  if (!agentId || !provider || !state || !manifest || !postUrl || !setupUrl || !createdAt || !appName || !label) return null;
  const conversion = normalizeGitHubAppManifestConversionResult(raw.conversion);
  return { agentId, provider, state, manifest, postUrl, setupUrl, createdAt, label, appName, ...(conversion ? { conversion } : {}) };
}

function parseManifestName(manifest: string): unknown {
  try {
    const parsed = JSON.parse(manifest);
    return isRecord(parsed) ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

function parseManifestSetupUrl(manifest: string): unknown {
  try {
    const parsed = JSON.parse(manifest);
    return isRecord(parsed) ? parsed.setup_url : undefined;
  } catch {
    return undefined;
  }
}

function getGitHubAppSetupUrl(appUrl: string, state: string): string {
  const url = new URL(appUrl);
  url.searchParams.set("githubAppManifest", "install");
  url.searchParams.set("state", state);
  url.searchParams.delete("code");
  url.searchParams.delete("installation_id");
  url.searchParams.delete("setup_action");
  return url.toString();
}

function normalizeGitHubAppManifestConversionResult(raw: unknown): ConvertGitHubAppManifestResult | null {
  if (!isRecord(raw)) return null;
  const agentId = readString(raw.agentId);
  const provider = readProvider(raw.provider);
  const appId = readString(raw.appId);
  const appSlug = readString(raw.appSlug);
  const appName = readString(raw.appName);
  const githubUsername = readString(raw.githubUsername);
  const privateKeyFile = readString(raw.privateKeyFile);
  const installUrl = readString(raw.installUrl);
  if (!agentId || !provider || !appId || !appSlug || !appName || !githubUsername || !privateKeyFile || !installUrl) return null;
  return { agentId, provider, appId, appSlug, appName, githubUsername, privateKeyFile, installUrl };
}

async function persistGitHubAppManifestConversion(flow: GitHubAppManifestFlowState, rawConversion: unknown): Promise<ConvertGitHubAppManifestResult> {
  if (!isRecord(rawConversion)) {
    throw new Error("GitHub App manifest conversion returned an invalid response.");
  }
  const appId = readString(rawConversion.id) || String(rawConversion.id ?? "").trim();
  const appSlug = readString(rawConversion.slug);
  const appName = readString(rawConversion.name);
  const pem = readString(rawConversion.pem);
  if (!appId || !appSlug || !appName || !pem) {
    throw new Error("GitHub App manifest conversion response is missing id, slug, name, or pem.");
  }

  const agentId = validateSinglePathSegment(readRequiredString(flow.agentId, "agentId"), "agentId");
  const privateKeyFile = join(dirname(await resolveCredentialSidecarPath()), "github-apps", agentId, "private-key.pem");
  await mkdir(dirname(privateKeyFile), { recursive: true });
  await writeFile(privateKeyFile, pem.endsWith("\n") ? pem : `${pem}\n`, { encoding: "utf8", mode: 0o600 });

  return {
    agentId,
    provider: flow.provider,
    appId,
    appSlug,
    appName,
    githubUsername: `${appSlug}[bot]`,
    privateKeyFile,
    installUrl: `https://github.com/apps/${appSlug}/installations/new?state=${encodeURIComponent(flow.state)}`,
  };
}

function readOptionalUrl(value: unknown, field: string): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("URL must use http or https");
    }
    return parsed.toString();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${field} must be a valid URL: ${message}`);
  }
}
