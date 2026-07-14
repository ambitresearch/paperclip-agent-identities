import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { SlackAgentIdentity } from "../config.js";
import type { SlackChannelRef, SlackChannelRefParams } from "../channel-ref.js";
import { resolveSlackChannelRef } from "../channel-ref.js";
import {
  slackBotPostMessageToolMetadata,
  slackBotPostMessageToolName,
  SLACK_MESSAGE_TEXT_MAX_LENGTH,
  SLACK_MESSAGE_BLOCKS_MAX_COUNT,
  SLACK_MESSAGE_BLOCKS_MAX_SERIALIZED_LENGTH
} from "../../../shared/slack-bot-post-message-tool.js";

// threadTs is optional: when present, the message is posted as a threaded
// reply to that parent message timestamp (Slack's `thread_ts`). When absent,
// the message is posted as a top-level message.
export interface SlackPostMessageParams {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  teamId?: string;
}

// Slack's own JSON values (block elements) are effectively arbitrary nested
// objects, but we forbid function/undefined-bearing values (which JSON.stringify
// would silently drop or throw on) by round-tripping through JSON.
function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

// Bounded allowlist of safe, non-interactive Block Kit block types. No
// action/button/select/input elements are permitted anywhere in this tool —
// this is a one-way message-posting tool, not an interactive-surfaces
// builder, so there is no callback path to receive a block_actions payload
// safely. Each entry maps a block `type` to the exact set of fields it may
// carry; anything outside this allowlist (unknown block types, unknown
// fields, or nested unsupported shapes) is rejected.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// Slack-documented per-field limits for the block types this tool allows.
// See https://api.slack.com/reference/block-kit/blocks and
// https://api.slack.com/reference/block-kit/composition-objects#text —
// mirrored in src/shared/slack-bot-post-message-tool.ts's JSON schema.
const SLACK_SECTION_TEXT_MAX_LENGTH = 3000;
const SLACK_SECTION_FIELDS_MAX_COUNT = 10;
const SLACK_FIELD_TEXT_MAX_LENGTH = 2000;
const SLACK_HEADER_TEXT_MAX_LENGTH = 150;
const SLACK_CONTEXT_ELEMENTS_MAX_COUNT = 10;
const SLACK_IMAGE_URL_MAX_LENGTH = 3000;
const SLACK_IMAGE_ALT_TEXT_MAX_LENGTH = 2000;
const SLACK_BLOCK_ID_MAX_LENGTH = 255;

function isSafeBlockId(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && value.length <= SLACK_BLOCK_ID_MAX_LENGTH;
}

// A Slack "text object" (used by section/context): { type: "mrkdwn" |
// "plain_text", text: string, emoji?: boolean } — no other fields. Slack
// caps section/field text objects at 3000/2000 characters respectively; the
// caller passes the appropriate max for the context it's validating.
function isSafeTextObject(value: unknown, maxLength: number): boolean {
  if (!isPlainObject(value)) return false;
  const allowedKeys = new Set(["type", "text", "emoji"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) return false;
  if (value.type !== "mrkdwn" && value.type !== "plain_text") return false;
  if (!isNonEmptyString(value.text)) return false;
  if ((value.text as string).length > maxLength) return false;
  if (value.emoji !== undefined && typeof value.emoji !== "boolean") return false;
  return true;
}

// A Slack "plain_text"-only text object, used by header text and image
// title — Slack rejects "mrkdwn" in these positions even though the
// composition object shape is otherwise identical to a general text object.
function isSafePlainTextObject(value: unknown, maxLength: number): boolean {
  if (!isPlainObject(value)) return false;
  const allowedKeys = new Set(["type", "text", "emoji"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) return false;
  if (value.type !== "plain_text") return false;
  if (!isNonEmptyString(value.text)) return false;
  if ((value.text as string).length > maxLength) return false;
  if (value.emoji !== undefined && typeof value.emoji !== "boolean") return false;
  return true;
}

// A Slack Block Kit `image` element (used inside `context` blocks' elements
// array), NOT the top-level `image` block: { type: "image", image_url:
// string, alt_text: string }.
function isSafeImageElement(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const allowedKeys = new Set(["type", "image_url", "alt_text"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) return false;
  if (value.type !== "image") return false;
  if (!isNonEmptyString(value.image_url)) return false;
  if ((value.image_url as string).length > SLACK_IMAGE_URL_MAX_LENGTH) return false;
  if (!isNonEmptyString(value.alt_text)) return false;
  if ((value.alt_text as string).length > SLACK_IMAGE_ALT_TEXT_MAX_LENGTH) return false;
  return true;
}

function isSafeBlock(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const type = value.type;

  switch (type) {
    case "divider": {
      const allowedKeys = new Set(["type", "block_id"]);
      const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length > 0) return false;
      if (!isSafeBlockId(value.block_id)) return false;
      return true;
    }
    case "section": {
      const allowedKeys = new Set(["type", "block_id", "text", "fields"]);
      const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length > 0) return false;
      if (!isSafeBlockId(value.block_id)) return false;
      const hasText = value.text !== undefined;
      const hasFields = value.fields !== undefined;
      if (!hasText && !hasFields) return false;
      if (hasText && !isSafeTextObject(value.text, SLACK_SECTION_TEXT_MAX_LENGTH)) return false;
      if (hasFields) {
        if (!Array.isArray(value.fields) || value.fields.length === 0) return false;
        if (value.fields.length > SLACK_SECTION_FIELDS_MAX_COUNT) return false;
        if (!value.fields.every((field) => isSafeTextObject(field, SLACK_FIELD_TEXT_MAX_LENGTH))) return false;
      }
      return true;
    }
    case "header": {
      const allowedKeys = new Set(["type", "block_id", "text"]);
      const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length > 0) return false;
      if (!isSafeBlockId(value.block_id)) return false;
      // header text is always plain_text, per Slack's Block Kit spec, and
      // capped at 150 characters.
      if (!isSafePlainTextObject(value.text, SLACK_HEADER_TEXT_MAX_LENGTH)) return false;
      return true;
    }
    case "context": {
      const allowedKeys = new Set(["type", "block_id", "elements"]);
      const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length > 0) return false;
      if (!isSafeBlockId(value.block_id)) return false;
      if (!Array.isArray(value.elements) || value.elements.length === 0) return false;
      if (value.elements.length > SLACK_CONTEXT_ELEMENTS_MAX_COUNT) return false;
      if (
        !value.elements.every(
          (el) => isSafeTextObject(el, SLACK_FIELD_TEXT_MAX_LENGTH) || isSafeImageElement(el)
        )
      )
        return false;
      return true;
    }
    case "image": {
      const allowedKeys = new Set(["type", "block_id", "image_url", "alt_text", "title"]);
      const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
      if (unknownKeys.length > 0) return false;
      if (!isSafeBlockId(value.block_id)) return false;
      if (!isNonEmptyString(value.image_url)) return false;
      if ((value.image_url as string).length > SLACK_IMAGE_URL_MAX_LENGTH) return false;
      if (!isNonEmptyString(value.alt_text)) return false;
      if ((value.alt_text as string).length > SLACK_IMAGE_ALT_TEXT_MAX_LENGTH) return false;
      if (value.title !== undefined && !isSafePlainTextObject(value.title, SLACK_HEADER_TEXT_MAX_LENGTH))
        return false;
      return true;
    }
    default:
      // Explicitly rejects interactive/action block types (actions, input,
      // section-with-accessory-buttons, etc.) and anything unrecognized.
      return false;
  }
}

const ALLOWED_PARAM_KEYS = new Set(["channel", "text", "blocks", "threadTs", "teamId"]);

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;

  const unknownKeys = Object.keys(p).filter((key) => !ALLOWED_PARAM_KEYS.has(key));
  if (unknownKeys.length > 0) {
    return { ok: false, error: `Unsupported parameter(s): ${unknownKeys.join(", ")}` };
  }

  if (!p.channel || typeof p.channel !== "string") {
    return { ok: false, error: "channel is required (a resolved Slack conversation ID)" };
  }
  if (!isNonEmptyString(p.text)) {
    return { ok: false, error: "text is required and must not be empty or whitespace-only" };
  }
  if ((p.text as string).length > SLACK_MESSAGE_TEXT_MAX_LENGTH) {
    return {
      ok: false,
      error: `text exceeds the maximum length of ${SLACK_MESSAGE_TEXT_MAX_LENGTH} characters`
    };
  }
  if (p.blocks !== undefined) {
    if (!Array.isArray(p.blocks)) {
      return { ok: false, error: "blocks must be an array if provided" };
    }
    if (p.blocks.length > SLACK_MESSAGE_BLOCKS_MAX_COUNT) {
      return { ok: false, error: `blocks exceeds the maximum count of ${SLACK_MESSAGE_BLOCKS_MAX_COUNT}` };
    }
    if (!isJsonSerializable(p.blocks)) {
      return { ok: false, error: "blocks must be JSON-serializable" };
    }
    if (JSON.stringify(p.blocks).length > SLACK_MESSAGE_BLOCKS_MAX_SERIALIZED_LENGTH) {
      return {
        ok: false,
        error: `blocks exceeds the maximum serialized size of ${SLACK_MESSAGE_BLOCKS_MAX_SERIALIZED_LENGTH} characters`
      };
    }
    const unsafeIndex = p.blocks.findIndex((block) => !isSafeBlock(block));
    if (unsafeIndex !== -1) {
      return {
        ok: false,
        error:
          `blocks[${unsafeIndex}] is not a supported block shape. Only divider, section, header, context, ` +
          `and image blocks (with plain text/mrkdwn text objects and no interactive elements) are allowed.`
      };
    }
  }
  if (p.threadTs !== undefined && typeof p.threadTs !== "string") {
    return { ok: false, error: "threadTs must be a string if provided" };
  }
  if (p.teamId !== undefined && typeof p.teamId !== "string") {
    return { ok: false, error: "teamId must be a string if provided" };
  }

  const validated: SlackPostMessageParams = {
    channel: p.channel,
    text: p.text,
    blocks: p.blocks as unknown[] | undefined,
    threadTs: p.threadTs as string | undefined,
    teamId: p.teamId as string | undefined
  };
  return { ok: true, params: validated };
}

interface SlackChatPostMessageResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  channel?: string;
  message?: { thread_ts?: string };
  team?: string;
}

interface SlackPermalinkResponse {
  ok: boolean;
  permalink?: string;
  error?: string;
}

async function fetchPermalink(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  token: string,
  channel: string,
  messageTs: string
): Promise<string | undefined> {
  try {
    const url = new URL("https://slack.com/api/chat.getPermalink");
    url.searchParams.set("channel", channel);
    url.searchParams.set("message_ts", messageTs);
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });
    const body = (await response.json().catch(() => ({}))) as SlackPermalinkResponse;
    if (response.ok && body.ok && typeof body.permalink === "string") {
      return body.permalink;
    }
    return undefined;
  } catch {
    // Permalink is best-effort metadata; never fail the post because of it.
    return undefined;
  }
}

// Redacts anything that could contain the bot token from an error message
// before it is returned to the caller or logged. Defense-in-depth: the token
// is never interpolated into error strings by this module, but this guards
// against a Slack response body that happens to echo back an Authorization
// header value.
function redact(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join("[REDACTED]");
}

export const slackBotPostMessageToolSpec: ProviderToolSpec<SlackAgentIdentity, SlackChannelRef> = {
  name: slackBotPostMessageToolName,
  metadata: slackBotPostMessageToolMetadata,
  requiresCredential: true,
  // Opts this credentialed tool into the live worker/manifest surface ahead
  // of the Slack provider's own `definition.status` flipping to "enabled"
  // (mirrors `slackWhoamiToolSpec`'s use of the same seam — see
  // `ProviderRegistry.liveTools()`). Keeps src/worker.ts and src/manifest.ts
  // provider-agnostic: no Slack-specific branch is added there.
  live: true,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<SlackAgentIdentity>
  ): Promise<ResourceRefResolution<SlackChannelRef>> {
    const params = input.params as SlackPostMessageParams;
    const refParams: SlackChannelRefParams = {
      channel: params.channel,
      teamId: params.teamId,
      threadTs: params.threadTs
    };
    return resolveSlackChannelRef(input, refParams);
  },
  async perform(
    execution: ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>
  ): Promise<unknown> {
    if (execution.token === null) {
      return { error: "Internal error: missing resolved credential." };
    }
    const token = execution.token;
    const ctx = execution.ctx;
    const runCtx = execution.runCtx;
    const validated = execution.params as SlackPostMessageParams;
    const ref = execution.resourceRef as SlackChannelRef;

    const body: Record<string, unknown> = {
      channel: ref.channel,
      text: validated.text
    };
    if (validated.blocks !== undefined) body.blocks = validated.blocks;
    if (ref.threadTs !== undefined) body.thread_ts = ref.threadTs;

    let response: Response;
    try {
      response = await ctx.http.fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`slack_bot_post_message network failure: ${redact(reason, token)}`);
      return { error: "Slack API request failed before a response was received." };
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After") ?? undefined;
      const reason = retryAfter
        ? `Slack rate-limited this request. Retry after ${retryAfter} second(s).`
        : "Slack rate-limited this request.";
      ctx.logger.error(`slack_bot_post_message rate limited${retryAfter ? ` (retry-after=${retryAfter})` : ""}`);
      return { error: reason, code: "rate_limited", retryAfter };
    }

    let parsed: SlackChatPostMessageResponse;
    try {
      parsed = (await response.json()) as SlackChatPostMessageResponse;
    } catch {
      return { error: `Slack API returned an unparseable response (HTTP ${response.status}).` };
    }

    if (!response.ok || !parsed.ok) {
      const code = parsed.error ?? `http_${response.status}`;
      const message = describeSlackError(code);
      ctx.logger.error(`slack_bot_post_message failed: ${redact(code, token)}`);
      return { error: message, code };
    }

    const messageTs = parsed.ts;
    const conversation = parsed.channel ?? ref.channel;
    const threadTs = parsed.message?.thread_ts ?? ref.threadTs;

    if (!messageTs) {
      return { error: "Slack API returned success without a message timestamp." };
    }

    const permalink = await fetchPermalink(ctx.http.fetch, token, conversation, messageTs);

    await ctx.activity.log({
      companyId: runCtx.companyId,
      entityType: "slack_message",
      entityId: messageTs,
      message: threadTs
        ? `Posted a threaded Slack reply in ${conversation}`
        : `Posted a Slack message to ${conversation}`,
      metadata: {
        teamId: ref.teamId,
        channel: conversation,
        messageTs,
        threadTs,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`slack_bot_post_message posted ${messageTs} to ${conversation}`);

    return {
      content: threadTs
        ? `Posted threaded reply in ${conversation} (thread ${threadTs})`
        : `Posted message to ${conversation}`,
      data: {
        team: ref.teamId,
        conversation,
        messageTs,
        threadTs,
        permalink
      }
    };
  }
};

function describeSlackError(code: string): string {
  switch (code) {
    case "channel_not_found":
      return "Slack denied the request: the conversation was not found (channel_not_found).";
    case "not_in_channel":
      return "Slack denied the request: the bot is not a member of this conversation (not_in_channel). " +
        "Invite the bot or grant chat:write.public for public channels.";
    case "missing_scope":
      return "Slack denied the request: the bot token is missing a required OAuth scope (missing_scope, expected chat:write).";
    case "is_archived":
      return "Slack denied the request: the conversation is archived (is_archived).";
    case "thread_not_found":
      return "Slack denied the request: the parent thread was not found (thread_not_found).";
    case "invalid_auth":
    case "account_inactive":
    case "token_revoked":
      return `Slack denied the request: credential is invalid or revoked (${code}).`;
    default:
      return `Slack API returned an error: ${code}`;
  }
}
