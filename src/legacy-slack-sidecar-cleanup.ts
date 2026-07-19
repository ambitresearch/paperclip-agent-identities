import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CONFIG_SCOPE } from "./config-source.js";
import {
  BOT_IDENTITY_SETTINGS_VERSION,
  LEGACY_SLACK_CLEANUP_TOMBSTONE_VERSION,
  normalizeSettingsState,
  type AgentIdentitySettingsState,
  type LegacySlackSidecarCleanupTombstone,
} from "./core/identity-config.js";
import {
  deleteLegacySlackCredentialSidecarEntry,
  readCredentialSidecarIfExists,
  readLegacySlackCredentialSidecarEntry,
  type LegacySlackCredentialSidecarEntry,
} from "./credential-sidecar.js";

export function getLegacySlackSidecarCleanupId(companyId: string, agentId: string): string {
  return `legacy-slack-sidecar:${encodeURIComponent(companyId)}:${encodeURIComponent(agentId)}`;
}

export function stageLegacySlackSidecarCleanup(
  state: AgentIdentitySettingsState,
  input: {
    companyId: string;
    agentId: string;
    source: LegacySlackSidecarCleanupTombstone["source"];
    expected?: LegacySlackCredentialSidecarEntry;
  },
): { state: AgentIdentitySettingsState; tombstone: LegacySlackSidecarCleanupTombstone } {
  const cleanupId = getLegacySlackSidecarCleanupId(input.companyId, input.agentId);
  const existing = state.cleanupTombstones[cleanupId];
  const tombstone: LegacySlackSidecarCleanupTombstone = existing
    ? {
        ...existing,
        ...(!existing.expected && input.expected ? { expected: input.expected } : {}),
      }
    : {
        version: LEGACY_SLACK_CLEANUP_TOMBSTONE_VERSION,
        cleanupId,
        companyId: input.companyId,
        agentId: input.agentId,
        provider: "slack",
        operation: "legacy-sidecar-delete",
        source: input.source,
        ...(input.expected ? { expected: input.expected } : {}),
      };

  return {
    state: {
      ...state,
      cleanupTombstones: {
        ...state.cleanupTombstones,
        [cleanupId]: tombstone,
      },
    },
    tombstone,
  };
}

export function findLegacySlackSidecarCleanup(
  state: AgentIdentitySettingsState,
  companyId: string,
  input: { cleanupId?: string; agentId?: string },
): LegacySlackSidecarCleanupTombstone | undefined {
  const cleanupId = input.cleanupId?.trim();
  const agentId = input.agentId?.trim();
  if (cleanupId) {
    const tombstone = state.cleanupTombstones[cleanupId];
    return tombstone?.companyId === companyId && (!agentId || tombstone.agentId === agentId)
      ? tombstone
      : undefined;
  }
  if (!agentId) return undefined;
  return Object.values(state.cleanupTombstones).find(
    (tombstone) => tombstone.companyId === companyId && tombstone.agentId === agentId,
  );
}

export async function persistLegacySlackSidecarCleanup(
  ctx: PluginContext,
  tombstone: LegacySlackSidecarCleanupTombstone,
): Promise<AgentIdentitySettingsState> {
  const current = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
  const staged = stageLegacySlackSidecarCleanup(current, {
    companyId: tombstone.companyId,
    agentId: tombstone.agentId,
    source: tombstone.source,
    ...(tombstone.expected ? { expected: tombstone.expected } : {}),
  });
  await ctx.state.set(CONFIG_SCOPE, staged.state);
  return staged.state;
}

export async function retryLegacySlackSidecarCleanup(
  ctx: PluginContext,
  tombstone: LegacySlackSidecarCleanupTombstone,
): Promise<AgentIdentitySettingsState> {
  let exact = tombstone;
  if (!exact.expected) {
    const sidecar = await readCredentialSidecarIfExists();
    const current = readLegacySlackCredentialSidecarEntry(sidecar, exact.agentId);
    if (current) {
      const state = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
      const persisted = state.cleanupTombstones[exact.cleanupId];
      if (!persisted || persisted.companyId !== exact.companyId || persisted.agentId !== exact.agentId) {
        throw new Error("Legacy Slack sidecar cleanup is no longer pending.");
      }
      exact = { ...persisted, expected: current };
      await ctx.state.set(CONFIG_SCOPE, {
        ...state,
        cleanupTombstones: {
          ...state.cleanupTombstones,
          [exact.cleanupId]: exact,
        },
      });
    } else {
      return await clearLegacySlackSidecarCleanup(ctx, exact);
    }
  }

  const expected = exact.expected;
  if (!expected) {
    throw new Error("Legacy Slack sidecar cleanup is missing its expected credential binding.");
  }
  await deleteLegacySlackCredentialSidecarEntry(exact.agentId, expected);
  return await clearLegacySlackSidecarCleanup(ctx, exact);
}

async function clearLegacySlackSidecarCleanup(
  ctx: PluginContext,
  tombstone: LegacySlackSidecarCleanupTombstone,
): Promise<AgentIdentitySettingsState> {
  const current = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
  const persisted = current.cleanupTombstones[tombstone.cleanupId];
  if (!persisted) return current;
  if (persisted.companyId !== tombstone.companyId || persisted.agentId !== tombstone.agentId) {
    throw new Error("Legacy Slack sidecar cleanup target changed before completion.");
  }
  const { [tombstone.cleanupId]: _cleared, ...cleanupTombstones } = current.cleanupTombstones;
  const next: AgentIdentitySettingsState = {
    version: BOT_IDENTITY_SETTINGS_VERSION,
    identities: current.identities,
    cleanupTombstones,
  };
  await ctx.state.set(CONFIG_SCOPE, next);
  return next;
}
