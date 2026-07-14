import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  ParamsValidation,
  ProviderToolExecution,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { SlackAgentIdentity } from "../config.js";
import type { SlackChannelRef, SlackChannelRefParams } from "../channel-ref.js";
import { resolveSlackChannelRef } from "../channel-ref.js";
import { validateSlackBlocks } from "../blocks.js";

const TEXT_MAX_LENGTH = 40_000;
const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
const SLACK_GET_PERMALINK_URL = "https://slack.com/api/chat.getPermalink";

export interface SlackPostMessageParams {
  readonly channel?: string;
  // Optional: when omitted, defaults to the resolved identity's own teamId.
  // When provided, must match the identity's teamId -- explicit
  // cross-workspace-ambiguity guard (see channel-ref.ts / openwiki §9), not a
  // way to select a different workspace.
  readonly teamId?: string;
  readonly threadTs?: string;
  readonly text: string;
  readonly blocks?: unknown[];
}

export interface SlackPostMessageResultData {
  readonly teamId: string;
  readonly channel: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly permalink?: string;
}

/**
 * Shared param validation for both `slack_bot_post_message` (threadTs
 * optional) and `slack_bot_post_reply` (threadTs required) -- the two tools
 * differ only in whether `threadTs` is mandatory, per
 * openwiki/domain/slack-provider-design.md §6 (`SlackMessageRef` vs
 * `SlackChannelRef`). Rejects unknown fields, non-string text, whitespace-only
 * text, oversized text, and defers `blocks` structural validation to
 * `validateSlackBlocks`.
 */
export function validateSlackPostParams(raw: unknown, options: { requireThreadTs: boolean }): ParamsValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = raw as Record<string, unknown>;
  const allowedKeys = new Set(["channel", "teamId", "threadTs", "text", "blocks"]);
  for (const key of Object.keys(p)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `Unsupported parameter: ${key}` };
    }
  }

  if (p.channel !== undefined && typeof p.channel !== "string") {
    return { ok: false, error: "channel must be a string if provided" };
  }

  if (p.teamId !== undefined && typeof p.teamId !== "string") {
    return { ok: false, error: "teamId must be a string if provided" };
  }

  if (options.requireThreadTs) {
    if (typeof p.threadTs !== "string" || !p.threadTs.trim()) {
      return { ok: false, error: "threadTs is required" };
    }
  } else if (p.threadTs !== undefined && typeof p.threadTs !== "string") {
    return { ok: false, error: "threadTs must be a string if provided" };
  }

  if (typeof p.text !== "string" || p.text.length === 0) {
    return { ok: false, error: "text is required and must be a non-empty string" };
  }
  if (!/\S/.test(p.text)) {
    return { ok: false, error: "text must contain at least one non-whitespace character" };
  }
  if (p.text.length > TEXT_MAX_LENGTH) {
    return { ok: false, error: `text must not exceed ${TEXT_MAX_LENGTH} characters` };
  }

  const blocksResult = validateSlackBlocks(p.blocks);
  if (!blocksResult.ok) {
    return { ok: false, error: blocksResult.error };
  }

  const validated: SlackPostMessageParams = {
    channel: p.channel as string | undefined,
    teamId: p.teamId as string | undefined,
    threadTs: p.threadTs as string | undefined,
    text: p.text,
    blocks: blocksResult.blocks
  };
  return { ok: true, params: validated };
}

/**
 * Shared resource-ref resolution for both post tools: reuses
 * `resolveSlackChannelRef` (channel-ref.ts) for the conversation ID +
 * cross-workspace guard, then requires a resolved `threadTs` when
 * `options.requireThreadTs` is set (the reply tool) -- this runs strictly
 * before credential resolution per the mandatory pipeline order.
 */
export async function resolveSlackPostResourceRef(
  input: ResourceRefResolverInput<SlackAgentIdentity>,
  options: { requireThreadTs: boolean }
): Promise<ResourceRefResolution<SlackChannelRef>> {
  const params = input.params as SlackPostMessageParams;
  const channel = params.channel ?? input.identity.identity.defaultChannel;
  if (!channel) {
    return {
      ok: false,
      error: "No channel provided and the configured identity has no default channel."
    };
  }

  const refParams: SlackChannelRefParams = { channel, teamId: params.teamId, threadTs: params.threadTs };
  const resolution = await resolveSlackChannelRef(input, refParams);
  if (!resolution.ok) return resolution;

  if (options.requireThreadTs && !resolution.ref?.threadTs) {
    return { ok: false, error: "threadTs is required and must be a valid Slack message timestamp." };
  }

  return resolution;
}

interface SlackApiErrorBody {
  readonly ok?: unknown;
  readonly error?: unknown;
}

interface SlackPostMessageResponseBody extends SlackApiErrorBody {
  readonly ts?: unknown;
  readonly channel?: unknown;
}

function toSafeSlackError(prefix: string, code: string): { error: string } {
  return { error: `${prefix}: ${code}` };
}

async function fetchPermalink(
  ctx: PluginContext,
  token: string,
  channel: string,
  messageTs: string
): Promise<string | undefined> {
  try {
    const response = await ctx.http.fetch(
      `${SLACK_GET_PERMALINK_URL}?channel=${encodeURIComponent(channel)}&message_ts=${encodeURIComponent(messageTs)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const body = (await response.json().catch(() => ({}))) as { ok?: unknown; permalink?: unknown };
    if (response.ok && body.ok === true && typeof body.permalink === "string") {
      return body.permalink;
    }
  } catch {
    // Best-effort only -- a permalink lookup failure must never fail the
    // overall post/reply, and must never surface a raw error/response body.
  }
  return undefined;
}

/**
 * Shared `perform` for both `slack_bot_post_message` and
 * `slack_bot_post_reply`: calls Slack's `chat.postMessage` with an optional
 * `thread_ts`, then best-effort resolves a permalink via
 * `chat.getPermalink`. Never logs or returns the bot token; Slack's stable
 * error codes (e.g. `channel_not_found`, `not_in_channel`, `ratelimited`) are
 * preserved in the returned `{ error }` shape so callers can act on them, but
 * no raw response body or token ever appears in output, logs, or thrown
 * errors -- the pipeline's redact step (tool-pipeline.ts) also scrubs
 * `credential.secrets` from whatever this returns, as defense in depth.
 */
export async function performSlackPostMessage(
  execution: ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>,
  toolName: string
): Promise<unknown> {
  if (execution.token === null) {
    return { error: "Internal error: missing resolved credential." };
  }
  const token = execution.token;
  const ctx = execution.ctx;
  const runCtx = execution.runCtx;
  const params = execution.params as SlackPostMessageParams;
  const ref = execution.resourceRef as SlackChannelRef;

  const body: Record<string, unknown> = { channel: ref.channel, text: params.text };
  if (ref.threadTs) body.thread_ts = ref.threadTs;
  if (params.blocks) body.blocks = params.blocks;

  let response: Response;
  try {
    response = await ctx.http.fetch(SLACK_POST_MESSAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body)
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown network error";
    ctx.logger.error(`${toolName} network failure: ${reason}`);
    return { error: "Slack API request failed before a response was received." };
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get("Retry-After");
    const retryAfterSeconds = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) : undefined;
    await response.json().catch(() => ({}));
    return {
      error: "ratelimited",
      retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined
    };
  }

  const parsed = (await response.json().catch(() => ({}))) as SlackPostMessageResponseBody;

  if (!response.ok || parsed.ok !== true) {
    const code = typeof parsed.error === "string" && parsed.error ? parsed.error : `http_${response.status}`;
    return toSafeSlackError(`${toolName} failed`, code);
  }

  if (typeof parsed.ts !== "string" || !parsed.ts) {
    return { error: `${toolName} failed: malformed Slack response (missing ts)` };
  }

  const messageTs = parsed.ts;
  const channel = typeof parsed.channel === "string" && parsed.channel ? parsed.channel : ref.channel;

  const permalink = await fetchPermalink(ctx, token, channel, messageTs);

  await ctx.activity.log({
    companyId: runCtx.companyId,
    entityType: "message",
    entityId: messageTs,
    message: `${toolName} posted a Slack message`,
    metadata: {
      agentId: runCtx.agentId,
      teamId: ref.teamId,
      channel,
      messageTs,
      ...(ref.threadTs ? { threadTs: ref.threadTs } : {})
    }
  });

  const data: SlackPostMessageResultData = {
    teamId: ref.teamId,
    channel,
    messageTs,
    ...(ref.threadTs ? { threadTs: ref.threadTs } : {}),
    ...(permalink ? { permalink } : {})
  };

  return {
    content: ref.threadTs
      ? `Posted threaded reply in ${channel} (ts ${messageTs}).`
      : `Posted message in ${channel} (ts ${messageTs}).`,
    data
  };
}
