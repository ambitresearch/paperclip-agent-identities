import { z, type PluginContext } from "@paperclipai/plugin-sdk";
import { createHash, randomBytes } from "node:crypto";
import { upsertCredentialSidecarIdentity, slackBotTokenSecretIdSchema } from "../../credential-sidecar.js";
import { getIdentityKey } from "../../shared/types.js";
import { normalizeSettingsState, BOT_IDENTITY_SETTINGS_VERSION, type AgentIdentitySettingsState } from "../../core/identity-config.js";
import { CONFIG_SCOPE } from "../../config-source.js";
import type {
  CreateSlackAppManifestInput,
  CreateSlackAppManifestResult,
  GetSlackAppManifestFlowInput,
  SaveSlackInstallMetadataInput,
  SaveSlackInstallMetadataResult,
  SlackAppManifestFlowState,
} from "../../shared/types.js";

const SLACK_APP_MANIFEST_FLOW_STATE_PREFIX = "slack-app-manifest-flow:";
const DEFAULT_SLACK_WORKER_HOST = "paperclip.example.com";
const SLACK_PROVIDER = "slack" as const;
// Setup-state flow is deliberately short-lived: it only needs to survive the
// operator's manifest-review -> install -> paste-back round trip, not a
// long-lived session.
const SLACK_APP_MANIFEST_FLOW_TTL_MS = 30 * 60 * 1000;

// MVP bot scopes only (see openwiki/domain/slack-provider-mvp.md §5 and
// §13): no `app_mentions:read` because inbound Events API ingress is
// deferred entirely for this slice.
const SLACK_MVP_BOT_SCOPES = ["chat:write", "channels:read", "groups:read", "reactions:write"] as const;

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

function validateSinglePathSegment(value: string, field: string): string {
  if (!value || value === "." || value === ".." || /[\\/]/.test(value)) {
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

// Slack's App Manifest schema caps `display_information.name` at 80
// characters and `display_information.description` at 100. These are
// display-only truncations of the manifest text; the full, untruncated
// `label` is always retained in flow/config state.
const SLACK_APP_NAME_MAX_LENGTH = 80;
const SLACK_APP_DESCRIPTION_MAX_LENGTH = 100;

function truncateForManifest(value: string, maxLength: number): string {
  // Truncate by Unicode code points, not UTF-16 code units: `.length`/`.slice`
  // operate on UTF-16 units, so an astral character (e.g. an emoji) straddling
  // the limit would otherwise be split into an unpaired surrogate, producing
  // an invalid Slack-facing display value.
  const codePoints = Array.from(value);
  return codePoints.length > maxLength ? codePoints.slice(0, maxLength).join("") : value;
}

function buildSlackAppName(label: string): string {
  const cleaned = label.replace(/\[[^\]]*\]/g, "").trim();
  return truncateForManifest(`Paperclip Agent — ${cleaned || label}`, SLACK_APP_NAME_MAX_LENGTH);
}

function buildSlackAppManifest(label: string): string {
  return JSON.stringify({
    _metadata: { major_version: 1, minor_version: 1 },
    display_information: {
      name: buildSlackAppName(label),
      description: truncateForManifest(`Paperclip agent identity for ${label}`, SLACK_APP_DESCRIPTION_MAX_LENGTH),
      background_color: "#4A154B",
    },
    oauth_config: {
      scopes: {
        bot: [...SLACK_MVP_BOT_SCOPES],
      },
    },
    settings: {
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  });
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
// slack-provider-design.md:86): `C...` for public channels, `G...` for
// private channels and multi-person conversations. This is syntax-only
// validation — authenticated existence/membership is checked at tool-use
// time, not here.
const slackDefaultChannelSchema = z.string().trim().regex(/^[CG][A-Z0-9]{8,}$/);

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
  // `workerHost` is accepted for API-shape parity with the design record's
  // `{{workerHost}}` placeholder, but the MVP manifest template intentionally
  // omits any Request URL / redirect URL (no event_subscriptions block), so
  // it is not interpolated into the manifest JSON itself.
  const manifest = buildSlackAppManifest(label);
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
  if (!agentId || !provider || !companyId || !state || !manifest || !createAppUrl || !createdAt || !expiresAt || !label) {
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

  ctx.actions.register("save-slack-install-metadata", async (params, context) => {
    const companyId = requireCompanyId(context as { companyId?: string | null } | undefined);
    const input = params as SaveSlackInstallMetadataInput;
    const state = readRequiredString(input.state, "state");
    const agentId = validateSinglePathSegment(readRequiredString(input.agentId, "agentId"), "agentId");
    const teamId = readRequiredString(input.teamId, "teamId");
    const appId = readRequiredString(input.appId, "appId");
    const botUserId = readRequiredString(input.botUserId, "botUserId");
    const botTokenSecretIdRaw = readRequiredString(input.botTokenSecretId, "botTokenSecretId");
    // Validate the secret reference shape up front — before any mutation —
    // using the same schema `upsertCredentialSidecarIdentity` enforces
    // later, so an invalid reference fails atomically instead of after
    // state has already been persisted.
    const botTokenSecretIdResult = slackBotTokenSecretIdSchema.safeParse(botTokenSecretIdRaw);
    if (!botTokenSecretIdResult.success) {
      throw new Error("botTokenSecretId must be a valid UUID.");
    }
    const botTokenSecretId = botTokenSecretIdResult.data;
    // Syntax-only channel-ID validation up front (before any mutation), per
    // the provider contract in openwiki/domain/slack-provider-design.md:
    // `^[CG][A-Z0-9]{8,}$`. Persisting a malformed/name-style value would
    // create config the resource resolver later rejects.
    const defaultChannelRaw = readString(input.defaultChannel) || undefined;
    let defaultChannel: string | undefined;
    if (defaultChannelRaw) {
      const defaultChannelResult = slackDefaultChannelSchema.safeParse(defaultChannelRaw);
      if (!defaultChannelResult.success) {
        throw new Error("defaultChannel must match the Slack channel ID pattern ^[CG][A-Z0-9]{8,}$.");
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
    // read-then-write instead of spanning the CONFIG_SCOPE and
    // credential-sidecar writes too.
    await ctx.state.set(slackAppManifestFlowScope(companyId, state), { ...flow, consumed: true });

    const identityId = getIdentityKey(agentId, SLACK_PROVIDER);
    let configWritten = false;
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
      configWritten = true;

      await upsertCredentialSidecarIdentity(agentId, SLACK_PROVIDER, {
        slackBotToken: { botTokenSecretId },
      });
    } catch (err) {
      // Either the CONFIG_SCOPE write or the credential-sidecar write (the
      // last step) failed, but the flow was already claimed above. Roll back
      // whatever partial mutation happened and re-open the flow state
      // (un-consume it) so the operator can safely retry the same `state`
      // instead of being left with identity metadata but no usable
      // credential and no way to resubmit.
      if (configWritten) {
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
      ...(defaultChannel ? { defaultChannel } : {}),
      status: "saved",
    };
    return result;
  });
}

export { DEFAULT_SLACK_WORKER_HOST };
