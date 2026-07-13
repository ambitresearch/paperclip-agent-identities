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
        description: "Message text to post."
      },
      blocks: {
        type: "array",
        description: "Optional Slack Block Kit blocks array (advanced formatting)."
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
    required: ["channel", "text"]
  }
} as const;

export const slackBotPostMessageManifestTool = {
  name: slackBotPostMessageToolName,
  ...slackBotPostMessageToolMetadata
} as const;
