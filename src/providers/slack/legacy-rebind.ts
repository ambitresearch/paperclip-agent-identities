import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CONFIG_SCOPE, configMutationLockKeys } from "../../config-source.js";
import { normalizeSettingsState, type SlackAgentIdentityConfig } from "../../core/identity-config.js";
import { withProcessLocalLocks } from "../../core/process-local-mutation-queue.js";
import { requireHumanSettingsActor } from "../../core/settings-action-authorization.js";
import { persistLegacySlackSidecarCleanup, stageLegacySlackSidecarCleanup } from "../../legacy-slack-sidecar-cleanup.js";
import {
  deleteLegacySlackCredentialSidecarEntry,
  readCredentialSidecarIfExists,
  readLegacySlackCredentialSidecarEntry,
  type GitHubBotIdentityCredentialSidecar,
  type LegacySlackCredentialSidecarEntry,
} from "../../credential-sidecar.js";
import type {
  LegacySlackCredentialRebindInput,
  LegacySlackCredentialRebindResult,
  LegacySlackCredentialStatus,
} from "../../shared/types.js";
import { getIdentityKey, REBIND_LEGACY_SLACK_CREDENTIALS_ACTION } from "../../shared/types.js";
import {
  createSlackSecretRef,
  readSlackIdentityConfigEntry,
  slackHostIdentityConfigSchema,
  slackIdentityConfigPath,
  slackSecretIdSchema,
  type SlackHostIdentityConfig,
} from "./config.js";

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requireCompanyId(context: { companyId?: string | null } | undefined): string {
  const companyId = readString(context?.companyId);
  if (!companyId) {
    throw new Error("Rebinding legacy Slack credentials requires a host-authorized companyId.");
  }
  return companyId;
}

function readSigningSecretId(value: unknown): string | undefined {
  const candidate = readString(value);
  if (!candidate) return undefined;
  const parsed = slackSecretIdSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("signingSecretId must be a valid UUID.");
  return parsed.data;
}

function publicMetadataMatches(
  identity: SlackAgentIdentityConfig,
  host: SlackHostIdentityConfig,
): boolean {
  return host.label === identity.label
    && host.teamId === identity.slack.teamId
    && host.appId === identity.slack.appId
    && host.botUserId === identity.slack.botUserId
    && (host.defaultChannel ?? "") === (identity.slack.defaultChannel ?? "");
}

function hostBindingMatches(
  identity: SlackAgentIdentityConfig,
  host: SlackHostIdentityConfig,
  legacy: LegacySlackCredentialSidecarEntry,
): boolean {
  return publicMetadataMatches(identity, host)
    && host.credentials.botToken.secretId === legacy.botTokenSecretId
    && (!legacy.signingSecretId || host.credentials.signingSecret.secretId === legacy.signingSecretId);
}

export function getLegacySlackCredentialStatus(
  sidecar: GitHubBotIdentityCredentialSidecar | null,
  companyConfig: Record<string, unknown>,
  identity: SlackAgentIdentityConfig,
): LegacySlackCredentialStatus | undefined {
  const legacy = readLegacySlackCredentialSidecarEntry(sidecar, identity.agentId);
  if (!legacy) return undefined;

  const existing = readSlackIdentityConfigEntry(companyConfig, identity.agentId);
  if (!existing) {
    return {
      status: "rebind-required",
      signingSecretRequired: !legacy.signingSecretId,
    };
  }

  const parsed = slackHostIdentityConfigSchema.safeParse(existing.value);
  if (!existing.legacy && parsed.success && hostBindingMatches(identity, parsed.data, legacy)) {
    return { status: "cleanup-pending", signingSecretRequired: false };
  }
  return { status: "conflict", signingSecretRequired: !legacy.signingSecretId };
}

function resolveSigningSecretId(
  legacy: LegacySlackCredentialSidecarEntry,
  supplied: string | undefined,
  existing: SlackHostIdentityConfig | undefined,
): string {
  if (legacy.signingSecretId) {
    if (supplied && supplied !== legacy.signingSecretId) {
      throw new Error("signingSecretId conflicts with the released Slack sidecar entry.");
    }
    return legacy.signingSecretId;
  }

  const existingSigningSecretId = existing?.credentials.signingSecret.secretId;
  if (existingSigningSecretId) {
    if (supplied && supplied !== existingSigningSecretId) {
      throw new Error("signingSecretId conflicts with the existing Slack host binding.");
    }
    return existingSigningSecretId;
  }
  if (!supplied) {
    throw new Error(
      "This released Slack sidecar entry has no signingSecretId. Supply the UUID of a Paperclip company secret containing the Slack signing secret.",
    );
  }
  return supplied;
}

export function contributeLegacySlackRebindAction(ctx: PluginContext): void {
  ctx.actions.register(REBIND_LEGACY_SLACK_CREDENTIALS_ACTION, async (params, context) => {
    requireHumanSettingsActor(context);
    const companyId = requireCompanyId(context as { companyId?: string | null } | undefined);
    const input = params as LegacySlackCredentialRebindInput;
    const agentId = readString(input.agentId);
    if (!agentId || /[.\\/]/.test(agentId)) {
      throw new Error("agentId is required and must be a single safe config path segment.");
    }
    const suppliedSigningSecretId = readSigningSecretId(input.signingSecretId);

    return await withProcessLocalLocks(
      ctx.state,
      configMutationLockKeys(companyId, agentId),
      async (): Promise<LegacySlackCredentialRebindResult> => {
        const agents = await ctx.agents.list({ companyId });
        if (!agents.some((agent) => agent.id === agentId)) {
          throw new Error("agentId does not belong to the host-authorized company.");
        }

        const settings = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
        const identityKey = getIdentityKey(agentId, "slack");
        const identity = settings.identities[identityKey];
        if (identity?.provider !== "slack") {
          throw new Error("No persisted public Slack identity exists for this agent.");
        }
        const publicIdentity = identity;

        const sidecar = await readCredentialSidecarIfExists();
        const legacy = readLegacySlackCredentialSidecarEntry(sidecar, agentId);
        const companyConfig = await ctx.config.get(companyId);
        const existingEntry = readSlackIdentityConfigEntry(companyConfig, agentId);
        const existingParsed = existingEntry && !existingEntry.legacy
          ? slackHostIdentityConfigSchema.safeParse(existingEntry.value)
          : undefined;

        if (!legacy) {
          if (existingParsed?.success && publicMetadataMatches(publicIdentity, existingParsed.data)) {
            return { agentId, provider: "slack", status: "rebound" };
          }
          throw new Error("No released Slack credential sidecar entry exists for this agent.");
        }

        const signingSecretId = resolveSigningSecretId(
          legacy,
          suppliedSigningSecretId,
          existingParsed?.success ? existingParsed.data : undefined,
        );
        const desired = slackHostIdentityConfigSchema.parse({
          label: publicIdentity.label,
          teamId: publicIdentity.slack.teamId,
          appId: publicIdentity.slack.appId,
          botUserId: publicIdentity.slack.botUserId,
          ...(publicIdentity.slack.defaultChannel
            ? { defaultChannel: publicIdentity.slack.defaultChannel }
            : {}),
          ...(existingParsed?.success && existingParsed.data.eventsRequestUrl
            ? { eventsRequestUrl: existingParsed.data.eventsRequestUrl }
            : {}),
          credentials: {
            botToken: createSlackSecretRef(legacy.botTokenSecretId),
            signingSecret: createSlackSecretRef(signingSecretId),
          },
        });
        let wroteHostBinding = false;

        if (existingEntry) {
          if (
            existingEntry.legacy
            || !existingParsed?.success
            || !publicMetadataMatches(publicIdentity, existingParsed.data)
            || existingParsed.data.credentials.botToken.secretId !== legacy.botTokenSecretId
            || existingParsed.data.credentials.signingSecret.secretId !== signingSecretId
          ) {
            throw new Error(
              "Existing Slack host binding conflicts with the released sidecar identity; it was not overwritten.",
            );
          }
        } else {
          await ctx.config.patchSecretRefs({
            companyId,
            path: [...slackIdentityConfigPath(agentId)],
            value: desired,
          });
          wroteHostBinding = true;
        }

        const currentConfig = await ctx.config.get(companyId);
        const currentEntry = readSlackIdentityConfigEntry(currentConfig, agentId);
        const current = currentEntry && !currentEntry.legacy
          ? slackHostIdentityConfigSchema.safeParse(currentEntry.value)
          : undefined;
        if (
          !current?.success
          || !publicMetadataMatches(publicIdentity, current.data)
          || current.data.credentials.botToken.secretId !== legacy.botTokenSecretId
          || current.data.credentials.signingSecret.secretId !== signingSecretId
        ) {
          throw new Error(
            wroteHostBinding
              ? "Slack host binding changed before legacy cleanup completed; verify company config before retrying."
              : "Existing Slack host binding changed before legacy cleanup; retry after reviewing company config.",
          );
        }

        try {
          await deleteLegacySlackCredentialSidecarEntry(agentId, legacy);
        } catch {
          const staged = stageLegacySlackSidecarCleanup(
            normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE)),
            {
              companyId,
              agentId,
              source: "legacy-rebind",
              expected: legacy,
            },
          );
          await persistLegacySlackSidecarCleanup(ctx, staged.tombstone);
          ctx.logger.warn("Legacy Slack sidecar cleanup is pending after host rebind", { agentId });
          return { agentId, provider: "slack", status: "cleanup-pending" };
        }

        ctx.logger.info("Released Slack credential references rebound to company config", { agentId });
        return { agentId, provider: "slack", status: "rebound" };
      },
    );
  });
}
