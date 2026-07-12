import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ResourceReference } from "../../core/resource-reference.js";
import type { ResourceRefResolution, ResourceRefResolverInput } from "../../core/provider-contract.js";
import type { SlackAgentIdentity } from "./config.js";

// Normalizes a Slack conversation reference *before* any credential is
// resolved — mirrors `normalizeGitHubRepoRef`/`GitHubRepoRef` (see
// `../github/repo-ref.ts`) but for Slack, per
// openwiki/domain/slack-provider-mvp.md §3 and §9 ("Cross-workspace IDs").
//
// Deliberately credential-free: Slack channel *name* -> ID lookup requires an
// authenticated `conversations.list`/`conversations.info` call, which cannot
// happen at this pre-credential pipeline stage (mandatory order: validate
// params -> resolve identity -> resolve resource ref -> resolve credentials
// -> perform -> redact). A caller that only has a channel name must go
// through the credentialed `slack-lookup-channel` tool (DRO-971, separate
// issue) first and pass its resolved ID in here. This module only ever
// accepts an already-resolved conversation ID and syntactically validates it.
export interface SlackChannelRef extends ResourceReference {
  readonly kind: "slack-channel";
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs?: string;
}

export interface SlackChannelRefParams {
  // Optional: when omitted, defaults to the resolved identity's own teamId.
  // When provided, must match the identity's teamId (see §9) — this is the
  // explicit cross-workspace-ambiguity guard, not a way to select a
  // different workspace.
  readonly teamId?: unknown;
  readonly channel?: unknown;
  readonly threadTs?: unknown;
}

// Slack conversation IDs are `[CDG]` (public channel / DM / private
// group-or-private-channel) followed by 8+ base32-ish uppercase
// alphanumerics. This intentionally rejects lowercase, channel *names*
// (`#general`, `general`), and deep-link URLs
// (`https://slack.com/app_redirect?channel=...` or
// `https://acme.slack.com/archives/C0123...`) — those must resolve through
// the credentialed lookup tool first.
const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{8,}$/;
const TEAM_ID_PATTERN = /^T[A-Z0-9]{8,}$/;
// Slack thread timestamps are `<10-digit seconds>.<6-digit micros>`, e.g.
// `1719000000.123456`. Kept structurally separate from `channel`/`teamId`
// (identity) per the acceptance criteria: it is optional and orthogonal to
// which conversation/workspace is targeted.
const THREAD_TS_PATTERN = /^\d{10}\.\d{6}$/;

function isUrlLike(value: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    /(^|\.)slack\.com(\/|$)/i.test(value) ||
    value.includes("/")
  );
}

export function normalizeSlackChannelId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isUrlLike(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.startsWith("#")) return null; // channel *names* are out of scope here
  if (!CHANNEL_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function normalizeSlackTeamId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (isUrlLike(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;
  if (!TEAM_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

// Returns `undefined` when the input itself was omitted (valid — the field
// is optional), `null` when present but malformed (invalid), or the
// normalized string.
export function normalizeSlackThreadTs(input: unknown): string | null | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!THREAD_TS_PATTERN.test(trimmed)) return null;
  return trimmed;
}

type SlackRefOutcome =
  | "invalid_channel"
  | "invalid_team_id"
  | "invalid_thread_ts"
  | "denied_team_mismatch";

async function logSlackRefOutcome(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  input: {
    message: string;
    outcome: SlackRefOutcome;
    channel?: string;
    teamId?: string;
    expectedTeamId?: string;
  }
): Promise<void> {
  // Metadata-only audit event: no token exists yet at this pipeline stage
  // (resource-ref resolution runs strictly before credential resolution),
  // so there is nothing secret to redact — only shareable IDs are logged.
  const metadata: Record<string, unknown> = {
    agentId: runCtx.agentId,
    runId: runCtx.runId,
    outcome: input.outcome
  };
  if (input.channel !== undefined) metadata.channel = input.channel;
  if (input.teamId !== undefined) metadata.teamId = input.teamId;
  if (input.expectedTeamId !== undefined) metadata.expectedTeamId = input.expectedTeamId;

  await ctx.activity.log({
    companyId: runCtx.companyId,
    entityType: "run",
    entityId: runCtx.runId,
    message: input.message,
    metadata
  });
}

/**
 * Resolves and validates a `SlackChannelRef` from raw tool params, strictly
 * before any credential is resolved (see mandatory pipeline order). Intended
 * to be called from each Slack tool's `resolveResourceRef` (DRO-971/973/974,
 * separate issues) once those tools exist; this module ships the shared
 * normalization + cross-workspace guard so no tool reimplements it.
 *
 * Fails closed on: malformed/URL-shaped/missing channel ID, malformed team
 * ID, malformed thread timestamp, or a `teamId` param that doesn't match the
 * resolved identity's own `teamId` (cross-workspace ambiguity — see
 * openwiki/domain/slack-provider-mvp.md §9). Every denial emits a
 * metadata-only audit event (no secrets are in scope at this stage).
 */
export async function resolveSlackChannelRef(
  input: ResourceRefResolverInput<SlackAgentIdentity>,
  params: SlackChannelRefParams
): Promise<ResourceRefResolution<SlackChannelRef>> {
  const { identity, ctx, runCtx } = input;

  const channel = normalizeSlackChannelId(params.channel);
  if (!channel) {
    await logSlackRefOutcome(ctx, runCtx, {
      message: "slack resource ref denied: invalid channel",
      outcome: "invalid_channel"
    });
    return {
      ok: false,
      error:
        "Invalid channel. Provide a resolved Slack conversation ID (e.g. 'C0123456789'), not a channel name or URL."
    };
  }

  const threadTs = normalizeSlackThreadTs(params.threadTs);
  if (threadTs === null) {
    await logSlackRefOutcome(ctx, runCtx, {
      message: "slack resource ref denied: invalid threadTs",
      outcome: "invalid_thread_ts",
      channel
    });
    return {
      ok: false,
      error: "Invalid threadTs. Expected Slack's '<seconds>.<micros>' timestamp format."
    };
  }

  const teamIdParam = params.teamId;
  const teamId = teamIdParam === undefined ? identity.identity.teamId : normalizeSlackTeamId(teamIdParam);
  if (!teamId) {
    await logSlackRefOutcome(ctx, runCtx, {
      message: "slack resource ref denied: invalid teamId",
      outcome: "invalid_team_id",
      channel
    });
    return { ok: false, error: "Invalid teamId. Expected a Slack team ID (e.g. 'T0123456789')." };
  }

  if (teamId !== identity.identity.teamId) {
    await logSlackRefOutcome(ctx, runCtx, {
      message: "slack resource ref denied: team mismatch",
      outcome: "denied_team_mismatch",
      channel,
      teamId,
      expectedTeamId: identity.identity.teamId
    });
    return {
      ok: false,
      error: `Slack resource denied: workspace mismatch. Expected team '${identity.identity.teamId}', got '${teamId}'.`
    };
  }

  const ref: SlackChannelRef = threadTs
    ? { kind: "slack-channel", teamId, channel, threadTs }
    : { kind: "slack-channel", teamId, channel };

  return { ok: true, ref };
}
