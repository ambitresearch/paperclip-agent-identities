export const slackBotPostMessageToolName = "slack_bot_post_message";

// Slack's `chat.postMessage` documents a de-facto ~40,000 character limit on
// `text`. We enforce a slightly more conservative, documented cap here so
// oversized payloads fail fast with a clear validation error instead of
// depending solely on Slack's own enforcement.
export const SLACK_MESSAGE_TEXT_MAX_LENGTH = 40000;

// `blocks` themselves can be large; Slack's Block Kit documents a 50-block
// limit per message. We cap the *serialized* size defensively so a
// pathological payload can't be used to smuggle arbitrary data through this
// tool.
export const SLACK_MESSAGE_BLOCKS_MAX_COUNT = 50;
export const SLACK_MESSAGE_BLOCKS_MAX_SERIALIZED_LENGTH = 40000;

// Required OAuth bot scope: `chat:write` (posting to channels the bot is a
// member of, and replying in threads via `thread_ts` — no separate scope is
// needed for threaded replies). `chat:write.public` is an OPTIONAL, gated
// scope that allows posting to public channels the bot has not been invited
// to; this tool does not request or require it, and does not special-case
// its presence/absence — Slack itself will return `not_in_channel` if the
// bot lacks membership and `chat:write.public` is not granted. See
// openwiki/domain/slack-provider-mvp.md §4.
// Manifest/JSON-schema mirror of the safe-block allowlist enforced by
// `isSafeBlock` in src/providers/slack/tools/post-message.ts. Interactive
// block types (actions/input/buttons/selects) are intentionally NOT
// representable here — this is a one-way message-posting tool with no
// callback path for block_actions payloads.
// Slack-documented per-field limits (see
// https://api.slack.com/reference/block-kit/blocks and
// https://api.slack.com/reference/block-kit/composition-objects#text),
// mirrored 1:1 in the runtime allowlist (`isSafeBlock` et al. in
// src/providers/slack/tools/post-message.ts).
const SLACK_BLOCK_ID_MAX_LENGTH = 255;
const SLACK_SECTION_TEXT_MAX_LENGTH = 3000;
const SLACK_SECTION_FIELDS_MAX_COUNT = 10;
const SLACK_FIELD_TEXT_MAX_LENGTH = 2000;
const SLACK_HEADER_TEXT_MAX_LENGTH = 150;
const SLACK_CONTEXT_ELEMENTS_MAX_COUNT = 10;
const SLACK_IMAGE_URL_MAX_LENGTH = 3000;
const SLACK_IMAGE_ALT_TEXT_MAX_LENGTH = 2000;

const SLACK_BLOCK_ID_SCHEMA = { type: "string", maxLength: SLACK_BLOCK_ID_MAX_LENGTH } as const;

const SLACK_TEXT_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["mrkdwn", "plain_text"] },
    text: { type: "string", minLength: 1, maxLength: SLACK_SECTION_TEXT_MAX_LENGTH },
    emoji: { type: "boolean" }
  },
  required: ["type", "text"],
  additionalProperties: false
} as const;

const SLACK_FIELD_TEXT_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["mrkdwn", "plain_text"] },
    text: { type: "string", minLength: 1, maxLength: SLACK_FIELD_TEXT_MAX_LENGTH },
    emoji: { type: "boolean" }
  },
  required: ["type", "text"],
  additionalProperties: false
} as const;

const SLACK_PLAIN_TEXT_OBJECT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["plain_text"] },
    text: { type: "string", minLength: 1, maxLength: SLACK_HEADER_TEXT_MAX_LENGTH },
    emoji: { type: "boolean" }
  },
  required: ["type", "text"],
  additionalProperties: false
} as const;

const SLACK_IMAGE_ELEMENT_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["image"] },
    image_url: { type: "string", minLength: 1, maxLength: SLACK_IMAGE_URL_MAX_LENGTH },
    alt_text: { type: "string", minLength: 1, maxLength: SLACK_IMAGE_ALT_TEXT_MAX_LENGTH }
  },
  required: ["type", "image_url", "alt_text"],
  additionalProperties: false
} as const;

const SLACK_BLOCK_ITEM_SCHEMA = {
  type: "object",
  description:
    "A single supported Block Kit block: divider, section, header, context, or image. " +
    "No interactive (actions/input/button/select) block types are supported.",
  oneOf: [
    {
      type: "object",
      properties: { type: { const: "divider" }, block_id: SLACK_BLOCK_ID_SCHEMA },
      required: ["type"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { const: "section" },
        block_id: SLACK_BLOCK_ID_SCHEMA,
        text: SLACK_TEXT_OBJECT_SCHEMA,
        fields: {
          type: "array",
          minItems: 1,
          maxItems: SLACK_SECTION_FIELDS_MAX_COUNT,
          items: SLACK_FIELD_TEXT_OBJECT_SCHEMA
        }
      },
      required: ["type"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { const: "header" },
        block_id: SLACK_BLOCK_ID_SCHEMA,
        text: SLACK_PLAIN_TEXT_OBJECT_SCHEMA
      },
      required: ["type", "text"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { const: "context" },
        block_id: SLACK_BLOCK_ID_SCHEMA,
        elements: {
          type: "array",
          minItems: 1,
          maxItems: SLACK_CONTEXT_ELEMENTS_MAX_COUNT,
          items: { oneOf: [SLACK_FIELD_TEXT_OBJECT_SCHEMA, SLACK_IMAGE_ELEMENT_SCHEMA] }
        }
      },
      required: ["type", "elements"],
      additionalProperties: false
    },
    {
      type: "object",
      properties: {
        type: { const: "image" },
        block_id: SLACK_BLOCK_ID_SCHEMA,
        image_url: { type: "string", minLength: 1, maxLength: SLACK_IMAGE_URL_MAX_LENGTH },
        alt_text: { type: "string", minLength: 1, maxLength: SLACK_IMAGE_ALT_TEXT_MAX_LENGTH },
        title: SLACK_PLAIN_TEXT_OBJECT_SCHEMA
      },
      required: ["type", "image_url", "alt_text"],
      additionalProperties: false
    }
  ]
} as const;

export const slackBotPostMessageToolMetadata = {
  displayName: "Post Slack Message (Agent Identity)",
  description:
    "Posts a message to a Slack conversation (or replies in a thread when threadTs is provided) " +
    "using the configured agent identity. Requires the bot to be a member of the target " +
    "conversation (or the optional chat:write.public scope for public channels).",
  parametersSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Resolved Slack conversation ID (e.g. \"C0123456789\"), not a channel name or URL."
      },
      text: {
        type: "string",
        minLength: 1,
        description: "Message text to post. Must not be empty or whitespace-only."
      },
      blocks: {
        type: "array",
        maxItems: SLACK_MESSAGE_BLOCKS_MAX_COUNT,
        items: SLACK_BLOCK_ITEM_SCHEMA,
        description:
          "Optional Slack Block Kit blocks array, restricted to a safe, non-interactive allowlist " +
          "(divider/section/header/context/image blocks only)."
      },
      threadTs: {
        type: "string",
        description:
          "Optional parent message timestamp ('<seconds>.<micros>') to post this message as a threaded reply."
      },
      teamId: {
        type: "string",
        description: "Optional Slack team ID; must match the configured identity's workspace if provided."
      }
    },
    required: ["channel", "text"],
    additionalProperties: false
  }
} as const;

export const slackBotPostMessageManifestTool = {
  name: slackBotPostMessageToolName,
  ...slackBotPostMessageToolMetadata
} as const;
