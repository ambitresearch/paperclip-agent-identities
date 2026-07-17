import { z, type PluginContext } from "@paperclipai/plugin-sdk";
import { createHash, randomBytes } from "node:crypto";
import {
  createSlackSecretRef,
  slackIdentityConfigPath,
  slackSecretIdSchema,
} from "./config.js";
import { discoverSlackAppId, verifySlackToken } from "./credentials.js";
import { getIdentityKey } from "../../shared/types.js";
import { normalizeSettingsState, BOT_IDENTITY_SETTINGS_VERSION, type AgentIdentitySettingsState } from "../../core/identity-config.js";
import { CONFIG_SCOPE } from "../../config-source.js";
import type {
  CreateSlackAppManifestInput,
  CreateSlackAppManifestResult,
  DiscoverSlackInstallMetadataInput,
  DiscoverSlackInstallMetadataResult,
  GetSlackAppManifestFlowInput,
  SaveSlackInstallMetadataInput,
  SaveSlackInstallMetadataResult,
  SlackAppManifestFlowState,
} from "../../shared/types.js";

const SLACK_APP_MANIFEST_FLOW_STATE_PREFIX = "slack-app-manifest-flow:";
const SLACK_PROVIDER = "slack" as const;
// Setup-state flow is deliberately short-lived: it only needs to survive the
// operator's manifest-review -> install -> paste-back round trip, not a
// long-lived session.
const SLACK_APP_MANIFEST_FLOW_TTL_MS = 30 * 60 * 1000;

const SLACK_MVP_BOT_SCOPES = [
  "assistant:write",
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "groups:read",
  "im:history",
  "reactions:write",
  "users:read",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Required fields: ${field}`);
  }
  return value.trim();
}

function normalizeEventsRequestUrl(value: unknown): string {
  const eventsRequestUrl = readRequiredString(value, "eventsRequestUrl");
  let parsed: URL;
  try {
    parsed = new URL(eventsRequestUrl);
  } catch {
    throw new Error("eventsRequestUrl must be a valid HTTPS URL with the exact /events path.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/events" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new Error("eventsRequestUrl must be an HTTPS URL with the exact /events path and no query or fragment.");
  }
  return eventsRequestUrl;
}

function validateSinglePathSegment(value: string, field: string): string {
  if (!value || /[.\\/]/.test(value)) {
    throw new Error(`${field} must be a single path segment.`);
  }
  return value;
}

function normalizeSlackProviderInput(value: unknown): typeof SLACK_PROVIDER {
  const provider = readString(value);
  if (provider && provider !== SLACK_PROVIDER) {
    throw new Error("Slack App manifest flow only supports the Slack provider.");
  }
  return SLACK_PROVIDER;
}

function slackAppManifestFlowScope(companyId: string, state: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    stateKey: `${SLACK_APP_MANIFEST_FLOW_STATE_PREFIX}${state}`,
  };
}

// Slack's App Manifest schema gives the app name and bot display name
// different limits. These are display-only truncations of the manifest text;
// the full, untruncated `label` is always retained in flow/config state.
const SLACK_APP_DISPLAY_NAME_MAX_LENGTH = 35;
const SLACK_BOT_DISPLAY_NAME_MAX_LENGTH = 80;
const SLACK_APP_DESCRIPTION_MAX_LENGTH = 100;

function truncateForManifest(value: string, maxLength: number): string {
  // Truncate by Unicode code points, not UTF-16 code units: `.length`/`.slice`
  // operate on UTF-16 units, so an astral character (e.g. an emoji) straddling
  // the limit would otherwise be split into an unpaired surrogate, producing
  // an invalid Slack-facing display value.
  const codePoints = Array.from(value);
  return codePoints.length > maxLength ? codePoints.slice(0, maxLength).join("") : value;
}

function buildSlackAppName(label: string, maxLength: number): string {
  const cleaned = label.replace(/\[[^\]]*\]/g, "").trim();
  return truncateForManifest(`Paperclip Agent - ${cleaned || label}`, maxLength);
}

function buildSlackAppManifest(label: string, eventsRequestUrl: string): string {
  return JSON.stringify({
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: buildSlackAppName(label, SLACK_APP_DISPLAY_NAME_MAX_LENGTH),
      description: truncateForManifest(`Paperclip agent identity for ${label}`, SLACK_APP_DESCRIPTION_MAX_LENGTH),
      background_color: "#4A154B",
    },
    features: {
      bot_user: {
        display_name: buildSlackAppName(label, SLACK_BOT_DISPLAY_NAME_MAX_LENGTH),
        always_online: false,
      },
      app_home: {
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      agent_view: {
        agent_description: truncateForManifest(
          `Paperclip agent identity for ${label}`,
          SLACK_APP_DESCRIPTION_MAX_LENGTH,
        ),
      },
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_MVP_BOT_SCOPES],
      },
    },
    settings: {
      event_subscriptions: {
        request_url: eventsRequestUrl,
        bot_events: ["app_home_opened", "app_mention", "message.im"],
      },
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  }, null, 2);
}

// `manifest_json` is not a documented Slack app-dashboard query parameter
// (see openwiki/domain/slack-provider-design.md:438-441), so it cannot
// reliably prefill the "Create an app" flow. The MVP setup flow is
// documented copy/paste only: this is the plain "create app" entry point,
// and the manifest JSON is surfaced separately (see
// `SlackAppManifestFlowState.manifest`) for the operator to paste in.
const SLACK_CREATE_APP_URL = "https://api.slack.com/apps?new_app=1";

function requireCompanyId(context: { companyId?: string | null } | undefined): string {
  // Only a host-authorized `context.companyId` is trusted. Caller-supplied
  // `params.companyId` must never be consulted here: accepting it would let
  // a caller in one company target another company's state namespace.
  const companyId = readString(context?.companyId ?? undefined);
  if (!companyId) {
    throw new Error("A host-authorized companyId is required for the Slack App manifest flow.");
  }
  return companyId;
}

// Same channel-ID syntax the resource resolver will enforce later (see
// openwiki/domain/slack-provider-design.md:568-570 /
// slack-provider-design.md:86): `C...` for public channels, `D...` for DMs,
// and `G...` for private channels and multi-person conversations. This is syntax-only
// validation — authenticated existence/membership is checked at tool-use
// time, not here.
const slackDefaultChannelSchema = z.string().trim().regex(/^[CDG][A-Z0-9]{8,}$/);

async function requireCompanyAgent(ctx: PluginContext, companyId: string, agentId: string): Promise<void> {
  const agents = await ctx.agents.list({ companyId });
  const belongs = agents.some((agent) => agent.id === agentId);
  if (!belongs) {
    throw new Error("agentId does not belong to the host-authorized company.");
  }
}

export function createSlackAppManifestFlow(
  input: CreateSlackAppManifestInput,
  companyId: string,
): SlackAppManifestFlowState {
  const agentId = validateSinglePathSegment(readRequiredString(input.agentId, "agentId"), "agentId");
  const provider = normalizeSlackProviderInput(input.provider);
  const label = readRequiredString(input.label, "label");
  const eventsRequestUrl = normalizeEventsRequestUrl(input.eventsRequestUrl);
  const manifest = buildSlackAppManifest(label, eventsRequestUrl);
  const state = `pc_${createHash("sha256")
    .update(`${companyId}:${agentId}:${provider}:${Date.now()}:${randomBytes(16).toString("hex")}`)
    .digest("hex")
    .slice(0, 32)}`;
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + SLACK_APP_MANIFEST_FLOW_TTL_MS);

  return {
    agentId,
    provider,
    companyId,
    state,
    manifest,
    createAppUrl: SLACK_CREATE_APP_URL,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    label,
    eventsRequestUrl,
  };
}

export function normalizeSlackAppManifestFlowState(raw: unknown): SlackAppManifestFlowState | null {
  if (!isRecord(raw)) return null;
  const agentId = readString(raw.agentId);
  const provider = readString(raw.provider) === SLACK_PROVIDER ? SLACK_PROVIDER : null;
  const companyId = readString(raw.companyId);
  const state = readString(raw.state);
  const manifest = readString(raw.manifest);
  const createAppUrl = readString(raw.createAppUrl);
  const createdAt = readString(raw.createdAt);
  const expiresAt = readString(raw.expiresAt);
  const label = readString(raw.label);
  const eventsRequestUrl = readString(raw.eventsRequestUrl);
  if (!agentId || !provider || !companyId || !state || !manifest || !createAppUrl || !createdAt || !expiresAt || !label || !eventsRequestUrl) {
    return null;
  }
  const consumed = raw.consumed === true;
  return {
    agentId,
    provider,
    companyId,
    state,
    manifest,
    createAppUrl,
    createdAt,
    expiresAt,
    label,
    eventsRequestUrl,
    ...(consumed ? { consumed: true } : {}),
  };
}

function toCreateResult(flow: SlackAppManifestFlowState): CreateSlackAppManifestResult {
  return {
    agentId: flow.agentId,
    provider: flow.provider,
    state: flow.state,
    manifest: flow.manifest,
    createAppUrl: flow.createAppUrl,
    createdAt: flow.createdAt,
    expiresAt: flow.expiresAt,
    label: flow.label,
    eventsRequestUrl: flow.eventsRequestUrl,
  };
}

function isFlowExpired(flow: SlackAppManifestFlowState, now = new Date()): boolean {
  return new Date(flow.expiresAt).getTime() <= now.getTime();
}

async function loadUnexpiredUnconsumedFlow(
  ctx: PluginContext,
  companyId: string,
  state: string,
): Promise<SlackAppManifestFlowState> {
  const flow = normalizeSlackAppManifestFlowState(await ctx.state.get(slackAppManifestFlowScope(companyId, state)));
  if (!flow || flow.state !== state || flow.companyId !== companyId) {
    throw new Error("Unknown or expired Slack App manifest flow state.");
  }
  if (flow.consumed) {
    throw new Error("Slack App manifest flow state has already been used.");
  }
  if (isFlowExpired(flow)) {
    // Best-effort cleanup; do not let a delete failure mask the expiry error.
    await ctx.state.delete(slackAppManifestFlowScope(companyId, state)).catch(() => undefined);
    throw new Error("Slack App manifest flow state has expired.");
  }
  return flow;
}

export function contributeSlackAppManifestActions(ctx: PluginContext): void {
  ctx.actions.register("create-slack-app-manifest", async (params, context) => {
    const companyId = requireCompanyId(context as { companyId?: string | null } | undefined);
    const flow = createSlackAppManifestFlow(params as CreateSlackAppManifestInput, companyId);
    await requireCompanyAgent(ctx, companyId, flow.agentId);
    await ctx.state.set(slackAppManifestFlowScope(companyId, flow.state), flow);
    // Do not log `state` — it is short-lived secret material (see
    // openwiki/domain/slack-provisioning-decision.md:147) that must never
    // appear in logs.
    ctx.logger.info("Slack App manifest flow created", { agentId: flow.agentId });
    return toCreateResult(flow);
  });

  ctx.actions.register("get-slack-app-manifest-flow", async (params, context) => {
    const companyId = requireCompanyId(context as { companyId?: string | null } | undefined);
    const input = params as GetSlackAppManifestFlowInput;
    const state = readRequiredString(input.state, "state");
    const flow = await loadUnexpiredUnconsumedFlow(ctx, companyId, state);
    return toCreateResult(flow);
  });

  ctx.actions.register("discover-slack-install-metadata", async (params, context) => {
    const companyId = requireCompanyId(context as { companyId?: string | null } | undefined);
    const input = params as DiscoverSlackInstallMetadataInput;
    const secretIdResult = slackSecretIdSchema.safeParse(input.botTokenSecretId);
    if (!secretIdResult.success) {
      throw new Error("botTokenSecretId must be a valid UUID.");
    }

    // The host resolves only exact, company-scoped secret bindings. Create a
    // short-lived setup binding, use it once for auth.test, and always delete
    // the whole subtree before returning. The random hash is a safe config
    // path segment and prevents concurrent setup requests from colliding.
    const setupKey = createHash("sha256")
      .update(`${companyId}:${Date.now()}:${randomBytes(16).toString("hex")}`)
      .digest("hex")
      .slice(0, 32);
    const setupPath = ["setup", "slack", "metadata", setupKey];
    const botTokenRef = createSlackSecretRef(secretIdResult.data);
    const configPath = [...setupPath, "botToken"].join(".");

    await ctx.config.patchSecretRefs({
      companyId,
      path: setupPath,
      value: { botToken: botTokenRef },
    });

    try {
      const token = await ctx.secrets.resolve(botTokenRef, { companyId, configPath });
      const verified = await verifySlackToken(token);
      if (!verified.botId) {
        throw new Error("The selected Paperclip secret does not contain a Slack bot token.");
      }
      const appId = await discoverSlackAppId(token, verified.botId);
      const result: DiscoverSlackInstallMetadataResult = {
        teamId: verified.teamId,
        botUserId: verified.userId,
        appId,
      };
      return result;
    } finally {
      await ctx.config.patchSecretRefs({ companyId, path: setupPath, value: null });
    }
  });

  ctx.actions.register("save-slack-install-metadata", async (params, context) => {
    const companyId = requireCompanyId(context as { companyId?: string | null } | undefined);
    const input = params as SaveSlackInstallMetadataInput;
    const state = readRequiredString(input.state, "state");
    const agentId = validateSinglePathSegment(readRequiredString(input.agentId, "agentId"), "agentId");
    const teamId = readRequiredString(input.teamId, "teamId");
    const appId = readRequiredString(input.appId, "appId");
    const botUserId = readRequiredString(input.botUserId, "botUserId");
    const botTokenSecretIdRaw = readRequiredString(input.botTokenSecretId, "botTokenSecretId");
    const signingSecretIdRaw = readRequiredString(input.signingSecretId, "signingSecretId");
    // Validate both secret IDs before any mutation. They are immediately
    // converted to typed secret-ref objects for host binding validation.
    const botTokenSecretIdResult = slackSecretIdSchema.safeParse(botTokenSecretIdRaw);
    if (!botTokenSecretIdResult.success) {
      throw new Error("botTokenSecretId must be a valid UUID.");
    }
    const botTokenSecretId = botTokenSecretIdResult.data;
    const signingSecretIdResult = slackSecretIdSchema.safeParse(signingSecretIdRaw);
    if (!signingSecretIdResult.success) {
      throw new Error("signingSecretId must be a valid UUID.");
    }
    const signingSecretId = signingSecretIdResult.data;
    // Syntax-only channel-ID validation up front (before any mutation), per
    // the provider contract in openwiki/domain/slack-provider-design.md:
    // `^[CDG][A-Z0-9]{8,}$`. Persisting a malformed/name-style value would
    // create config the resource resolver later rejects.
    const defaultChannelRaw = readString(input.defaultChannel) || undefined;
    let defaultChannel: string | undefined;
    if (defaultChannelRaw) {
      const defaultChannelResult = slackDefaultChannelSchema.safeParse(defaultChannelRaw);
      if (!defaultChannelResult.success) {
        throw new Error("defaultChannel must match the Slack conversation ID pattern ^[CDG][A-Z0-9]{8,}$.");
      }
      defaultChannel = defaultChannelResult.data;
    }

    const flow = await loadUnexpiredUnconsumedFlow(ctx, companyId, state);
    // Idempotency / anti-replay: a duplicate or replayed callback bound to a
    // different agent than the flow was created for must not be able to
    // overwrite that other agent's identity.
    if (flow.agentId !== agentId) {
      throw new Error("Slack App manifest flow state does not match the requested agentId.");
    }

    // Re-check company membership immediately before claiming the flow.
    // Membership was already checked at create time, but the flow's 30-minute
    // TTL means the agent could be deleted or moved to another company
    // before this save runs. Enforcing it again here means authorization is
    // checked at the point the write actually happens, not just at an
    // earlier point in time.
    await requireCompanyAgent(ctx, companyId, agentId);

    // Claim the flow (mark it consumed) BEFORE performing any further
    // mutations. `ctx.state` has no compare-and-swap/setIfAbsent primitive,
    // so this cannot be made fully atomic against a concurrent duplicate
    // save — both could still race between the `loadUnexpiredUnconsumedFlow`
    // read above and this write. Moving the consumed-write to be the first
    // mutation (instead of the last) shrinks that race window to a single
    // read-then-write instead of spanning the CONFIG_SCOPE and company
    // config writes too.
    await ctx.state.set(slackAppManifestFlowScope(companyId, state), { ...flow, consumed: true });

    const identityId = getIdentityKey(agentId, SLACK_PROVIDER);
    let settingsWritten = false;
    let previousIdentity: AgentIdentitySettingsState["identities"][string] | undefined;
    try {
      // Re-read CONFIG_SCOPE immediately before writing (not the value read
      // earlier, if any) and patch in only this identity's key. Restoring an
      // entire earlier snapshot on rollback could clobber unrelated identity
      // changes committed concurrently after this read; compensating only
      // this one key preserves any such newer entries.
      const currentState = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
      previousIdentity = currentState.identities[identityId];
      const nextState: AgentIdentitySettingsState = {
        version: BOT_IDENTITY_SETTINGS_VERSION,
        identities: {
          ...currentState.identities,
          [identityId]: {
            provider: "slack",
            id: identityId,
            agentId,
            label: flow.label,
            slack: {
              teamId,
              appId,
              botUserId,
              ...(defaultChannel ? { defaultChannel } : {}),
            },
          },
        },
      };
      await ctx.state.set(CONFIG_SCOPE, nextState);
      settingsWritten = true;

      // This host operation atomically persists the company-scoped identity
      // subtree and synchronizes bindings for only this identity prefix.
      await ctx.config.patchSecretRefs({
        companyId,
        path: slackIdentityConfigPath(agentId),
        value: {
          label: flow.label,
          teamId,
          appId,
          botUserId,
          eventsRequestUrl: flow.eventsRequestUrl,
          ...(defaultChannel ? { defaultChannel } : {}),
          credentials: {
            botToken: createSlackSecretRef(botTokenSecretId),
            signingSecret: createSlackSecretRef(signingSecretId),
          },
        },
      });
    } catch (err) {
      // The flow was already claimed above. If the settings projection was
      // written before the atomic host config update failed, restore only
      // this identity and re-open the flow so the operator can retry.
      if (settingsWritten) {
        const rollbackState = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE).catch(() => null));
        const { [identityId]: _current, ...remainingIdentities } = rollbackState.identities;
        const restoredIdentities = previousIdentity
          ? { ...remainingIdentities, [identityId]: previousIdentity }
          : remainingIdentities;
        await ctx.state
          .set(CONFIG_SCOPE, { version: BOT_IDENTITY_SETTINGS_VERSION, identities: restoredIdentities })
          .catch(() => undefined);
      }
      await ctx.state.set(slackAppManifestFlowScope(companyId, state), flow).catch(() => undefined);
      throw err;
    }

    // Do not log `state` here either — same short-lived secret material
    // constraint as above.
    ctx.logger.info("Slack install metadata saved", { agentId, teamId, appId, botUserId });

    // Success: delete the flow entirely rather than leaving a `consumed`
    // record behind indefinitely. `ctx.state` has no storage-level TTL, so
    // without this, both abandoned (never revisited) and successfully
    // consumed flows would retain the operator/company/agent linkage and
    // manifest text forever; expiry-driven cleanup in
    // `loadUnexpiredUnconsumedFlow` only covers flows someone looks up again.
    await ctx.state.delete(slackAppManifestFlowScope(companyId, state)).catch(() => undefined);

    const result: SaveSlackInstallMetadataResult = {
      agentId,
      provider: SLACK_PROVIDER,
      teamId,
      appId,
      botUserId,
      botTokenSecretId,
      signingSecretId,
      ...(defaultChannel ? { defaultChannel } : {}),
      status: "saved",
    };
    return result;
  });
}
