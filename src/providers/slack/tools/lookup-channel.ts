import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { ResourceReference } from "../../../core/resource-reference.js";
import type { SlackAgentIdentity } from "../config.js";
import {
  normalizeSlackChannelId,
  normalizeSlackTeamId
} from "../channel-ref.js";
import {
  SLACK_BOT_LOOKUP_CHANNEL_TOOL_NAME,
  slackBotLookupChannelToolMetadata
} from "../../../shared/slack-bot-lookup-channel-tool.js";

/**
 * `slack_bot_lookup_channel` (DRO-975 / DRO-1160): resolves a human-readable
 * Slack channel name (e.g. "general" or "#general") to its canonical
 * conversation ID and metadata via a credentialed `conversations.list` call.
 *
 * This tool exists specifically because `resolveSlackChannelRef`
 * (../channel-ref.ts) only ever accepts an already-resolved conversation ID
 * and runs BEFORE any credential is resolved — see the large comment block
 * at the top of that module. Name -> ID resolution needs Slack API access,
 * so it must be its own credentialed tool, with its own resource-ref
 * resolution step that only performs the (credential-free) cross-workspace
 * teamId guard — the actual name lookup happens in `perform`, once a
 * credential has been resolved.
 *
 * Security properties:
 *  - Cross-workspace guard: an explicit `teamId` param that doesn't match
 *    the resolved identity's own teamId is denied in `resolveResourceRef`,
 *    strictly before any credential is resolved or API call made (mirrors
 *    every other Slack tool's `resolveSlackChannelRef` usage).
 *  - Already-resolved-ID passthrough: when `channel` is already a valid
 *    conversation ID (matches the shared `CHANNEL_ID_PATTERN`), it is
 *    validated and returned as-is with NO additional API call — the
 *    "ID input remains supported and type/prefix consistency stays
 *    fail-closed" acceptance criterion.
 *  - Never auto-joins: only channels already visible to the bot via
 *    `conversations.list` (types=public_channel,private_channel,
 *    exclude_archived=true) are considered matches. Archived channels and
 *    channels the bot cannot see are excluded, not silently joined.
 *  - Bounded pagination: at most `MAX_PAGES` pages of at most `PAGE_LIMIT`
 *    results each are fetched, so a huge workspace cannot cause unbounded
 *    API calls; if the result set is truncated and no match was found yet,
 *    the tool still fails closed rather than looping forever.
 *  - Bounded rate-limit retries: a `429`/`rate_limited` response is retried
 *    up to `MAX_RATE_LIMIT_RETRIES` times (bounded backoff), then fails
 *    closed with an actionable error — never an unbounded retry loop.
 *  - Secret-free errors: network failures and non-ok responses are logged
 *    as a bare classification only (mirrors `performReaction`'s catch
 *    block in ../tools/react.ts) — the bot token is already in the
 *    Authorization header by the time any error could occur, so the raw
 *    thrown error/response is never logged or returned to the caller.
 *  - Ambiguity fails closed: multiple accessible channels sharing a name
 *    return an explicit error listing the conflicting IDs rather than
 *    silently picking one.
 */

const CHANNEL_ID_PATTERN = /^[CDG][A-Z0-9]{8,}$/;
const TEAM_ID_PATTERN = /^T[A-Z0-9]{8,}$/;

// Bounds on `conversations.list` pagination so a huge workspace cannot
// trigger unbounded API calls. 1000 is Slack's documented max per-page
// limit for this method.
const PAGE_LIMIT = 1000;
const MAX_PAGES = 10;
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 500;

export interface SlackLookupChannelParams {
  readonly channel: string;
  readonly teamId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeChannelQuery(input: string): string {
  // Human-readable channel names may be given with or without the leading
  // "#" and Slack channel names are always lowercase; normalize for
  // matching purposes only (the raw, user-supplied string is never sent to
  // the Slack API as a channel ID).
  return input.trim().replace(/^#/, "").toLowerCase();
}

/**
 * Validates raw tool params entirely locally — no network call, no
 * identity, no credential. Accepts either a channel name/ref string or an
 * already-resolved conversation ID; distinguishing between the two happens
 * in `perform`, since both are syntactically valid strings at this stage.
 */
function validateLookupChannelParams(raw: unknown): ParamsValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "params must be a non-null object" };
  }

  const { channel, teamId, ...rest } = raw;
  if (Object.keys(rest).length > 0) {
    return { ok: false, error: `Unknown parameter(s): ${Object.keys(rest).join(", ")}` };
  }

  if (typeof channel !== "string" || channel.trim().length === 0 || channel.trim().length > 100) {
    return {
      ok: false,
      error: "Invalid channel. Expected a non-empty channel name (e.g. 'general' or '#general') or a resolved Slack conversation ID, up to 100 characters."
    };
  }

  if (teamId !== undefined) {
    if (typeof teamId !== "string" || !TEAM_ID_PATTERN.test(teamId.trim())) {
      return {
        ok: false,
        error: "Invalid teamId. Expected a Slack team ID (e.g. 'T0123456789')."
      };
    }
  }

  const params: SlackLookupChannelParams = {
    channel: channel.trim(),
    ...(teamId !== undefined ? { teamId: teamId.trim() } : {})
  };

  return { ok: true, params };
}

/**
 * Resource-ref resolution here ONLY performs the credential-free
 * cross-workspace guard (mirrors `resolveSlackChannelRef`'s teamId check).
 * It deliberately does NOT resolve the channel name to an ID — that
 * requires a credential and happens in `perform`. This tool has no
 * meaningful "resource" to gate access to prior to the lookup itself, so
 * the ref is always `null`; `perform` re-derives what it needs from
 * `execution.params` and `execution.identity`.
 */
async function resolveLookupChannelResourceRef(
  input: ResourceRefResolverInput<SlackAgentIdentity>
): Promise<ResourceRefResolution<ResourceReference>> {
  const params = input.params as SlackLookupChannelParams;
  const { identity, ctx, runCtx } = input;

  const teamId =
    params.teamId === undefined ? identity.identity.teamId : normalizeSlackTeamId(params.teamId);
  if (!teamId) {
    return { ok: false, error: "Invalid teamId. Expected a Slack team ID (e.g. 'T0123456789')." };
  }

  if (teamId !== identity.identity.teamId) {
    // Metadata-only audit event: no token exists yet at this pipeline stage.
    await ctx.activity.log({
      companyId: runCtx.companyId,
      entityType: "run",
      entityId: runCtx.runId,
      message: "slack lookup-channel denied: team mismatch",
      metadata: {
        agentId: runCtx.agentId,
        runId: runCtx.runId,
        outcome: "denied_team_mismatch",
        teamId,
        expectedTeamId: identity.identity.teamId
      }
    });
    return {
      ok: false,
      error: `Slack resource denied: workspace mismatch. Expected team '${identity.identity.teamId}', got '${teamId}'.`
    };
  }

  return { ok: true, ref: null };
}

interface SlackConversation {
  readonly id: string;
  readonly name?: string;
  readonly is_archived?: boolean;
  readonly is_channel?: boolean;
  readonly is_group?: boolean;
  readonly is_private?: boolean;
  readonly is_im?: boolean;
}

interface ConversationsListPage {
  readonly conversations: readonly SlackConversation[];
  readonly nextCursor: string | undefined;
}

type ListPageResult =
  | { readonly ok: true; readonly page: ConversationsListPage }
  | { readonly ok: false; readonly error: string };

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function fetchConversationsListPage(
  fetchImpl: FetchLike,
  token: string,
  cursor: string | undefined
): Promise<ListPageResult> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      const url = new URL("https://slack.com/api/conversations.list");
      url.searchParams.set("types", "public_channel,private_channel");
      url.searchParams.set("exclude_archived", "true");
      url.searchParams.set("limit", String(PAGE_LIMIT));
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }
      response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      // Never log/return the raw thrown error: it may embed request
      // details (headers/body) and the bot token is already in the
      // Authorization header by this point. Mirrors performReaction's
      // catch block in ../tools/react.ts.
      return { ok: false, error: "Slack API request failed before a response was received." };
    }

    if (response.status === 429) {
      attempt += 1;
      if (attempt > MAX_RATE_LIMIT_RETRIES) {
        return {
          ok: false,
          error: "Slack API rate limit exceeded after repeated retries. Try again later."
        };
      }
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS * attempt));
      continue;
    }

    const body = (await response.json().catch(() => ({}))) as {
      ok?: unknown;
      error?: unknown;
      channels?: unknown;
      response_metadata?: { next_cursor?: unknown };
    };

    if (body.error === "rate_limited") {
      attempt += 1;
      if (attempt > MAX_RATE_LIMIT_RETRIES) {
        return {
          ok: false,
          error: "Slack API rate limit exceeded after repeated retries. Try again later."
        };
      }
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS * attempt));
      continue;
    }

    if (body.ok !== true) {
      const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      return { ok: false, error: `Slack API returned an error for conversations.list: ${reason}` };
    }

    const conversations = Array.isArray(body.channels) ? (body.channels as SlackConversation[]) : [];
    const nextCursor =
      typeof body.response_metadata?.next_cursor === "string" && body.response_metadata.next_cursor.length > 0
        ? body.response_metadata.next_cursor
        : undefined;

    return { ok: true, page: { conversations, nextCursor } };
  }
}

async function performLookupChannel(
  execution: ProviderToolExecution<SlackAgentIdentity, ResourceReference>
): Promise<unknown> {
  const ctx = execution.ctx;
  const runCtx = execution.runCtx;
  const params = execution.params as SlackLookupChannelParams;

  if (execution.token === null) {
    return { error: "Internal error: missing resolved credential." };
  }
  const token = execution.token;

  const trimmed = params.channel.trim();
  const asId = normalizeSlackChannelId(trimmed);
  if (asId) {
    // Already-resolved-ID passthrough: validate and return, no API call.
    return {
      content: `Channel reference '${trimmed}' is already a resolved conversation ID.`,
      data: { channelId: asId, resolvedFrom: "id" }
    };
  }

  const query = normalizeChannelQuery(trimmed);
  const matches: SlackConversation[] = [];
  let cursor: string | undefined;
  let pages = 0;

  for (; pages < MAX_PAGES; pages++) {
    const result = await fetchConversationsListPage(ctx.http.fetch as FetchLike, token, cursor);
    if (!result.ok) {
      ctx.logger.error("conversations.list failed while looking up a channel by name");
      await ctx.activity.log({
        companyId: runCtx.companyId,
        entityType: "run",
        entityId: runCtx.runId,
        message: "slack_bot_lookup_channel failed",
        metadata: {
          agentId: runCtx.agentId,
          runId: runCtx.runId,
          outcome: "slack_api_error"
        }
      });
      return { error: result.error };
    }

    for (const conversation of result.page.conversations) {
      if (conversation.is_archived) continue; // never surfaces archived channels as matches
      if (typeof conversation.name !== "string") continue;
      if (conversation.name.toLowerCase() === query) {
        matches.push(conversation);
      }
    }

    cursor = result.page.nextCursor;
    if (!cursor) break;
  }

  if (matches.length === 0) {
    await ctx.activity.log({
      companyId: runCtx.companyId,
      entityType: "run",
      entityId: runCtx.runId,
      message: "slack_bot_lookup_channel found no match",
      metadata: {
        agentId: runCtx.agentId,
        runId: runCtx.runId,
        outcome: "no_match",
        pagesScanned: pages
      }
    });
    return {
      error: `No accessible Slack channel named '${trimmed}' was found. It may not exist, may be archived, or the bot may not be a member of it.`
    };
  }

  if (matches.length > 1) {
    const ids = matches.map((m) => m.id);
    await ctx.activity.log({
      companyId: runCtx.companyId,
      entityType: "run",
      entityId: runCtx.runId,
      message: "slack_bot_lookup_channel found ambiguous matches",
      metadata: {
        agentId: runCtx.agentId,
        runId: runCtx.runId,
        outcome: "ambiguous",
        matchCount: ids.length,
        matchingIds: ids
      }
    });
    return {
      error: `Multiple accessible Slack channels are named '${trimmed}': ${ids.join(", ")}. Disambiguate by passing the resolved conversation ID directly.`
    };
  }

  const match = matches[0];
  await ctx.activity.log({
    companyId: runCtx.companyId,
    entityType: "run",
    entityId: runCtx.runId,
    message: "slack_bot_lookup_channel resolved a channel",
    metadata: {
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      outcome: "success",
      channelId: match.id
    }
  });

  return {
    content: `Resolved channel '${trimmed}' to ${match.id}.`,
    data: {
      channelId: match.id,
      name: match.name,
      isPrivate: Boolean(match.is_private),
      resolvedFrom: "name"
    }
  };
}

export const slackLookupChannelToolSpec: ProviderToolSpec<SlackAgentIdentity, ResourceReference> = {
  name: SLACK_BOT_LOOKUP_CHANNEL_TOOL_NAME,
  metadata: slackBotLookupChannelToolMetadata,
  // No `live: true` needed: the Slack provider's `toolsStatus` is already
  // "enabled" (see index.ts), which is `ProviderRegistry.liveTools()`'s
  // primary gate — `live` is only needed for a tool to opt in ahead of that
  // gate. Mirrors slackAddReactionToolSpec/slackRemoveReactionToolSpec in
  // ../tools/react.ts, which don't set it either.
  validateParams: validateLookupChannelParams,
  resolveResourceRef: resolveLookupChannelResourceRef,
  async perform(execution) {
    return performLookupChannel(execution);
  }
};

export { CHANNEL_ID_PATTERN };
