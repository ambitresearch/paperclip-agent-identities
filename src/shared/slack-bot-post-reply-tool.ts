export const slackBotPostReplyToolName = "slack_bot_post_reply";

const TEXT_MAX_LENGTH = 40_000;

export const slackBotPostReplyToolMetadata = {
  displayName: "Post Slack Threaded Reply",
  description:
    "Posts a threaded reply under an existing Slack message using the calling agent's " +
    "configured Slack bot identity. The bot must already be a member of the target " +
    "conversation -- Slack's own membership ACL is the enforced authorization boundary, not a " +
    "plugin-side allow-list.",
  parametersSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description:
          "Resolved Slack conversation ID (e.g. \"C0123456789\"), not a channel name or URL. " +
          "Falls back to the configured identity's default channel when omitted."
      },
      teamId: {
        type: "string",
        description:
          "Optional Slack team/workspace ID. Must match the configured identity's own team; " +
          "provided only as an explicit cross-workspace-ambiguity guard, never to select a " +
          "different workspace."
      },
      threadTs: {
        type: "string",
        description: "Parent message timestamp to reply under, in Slack's '<seconds>.<micros>' format.",
        pattern: "^\\d{10}\\.\\d{6}$"
      },
      text: {
        type: "string",
        description: "Reply text. Required, must contain at least one non-whitespace character.",
        maxLength: TEXT_MAX_LENGTH
      },
      blocks: {
        type: "array",
        description:
          "Optional static Block Kit blocks (section/divider/header/context only -- no " +
          "interactive components, accessories, or images)."
      }
    },
    required: ["threadTs", "text"],
    additionalProperties: false
  }
} as const;

export const slackBotPostReplyManifestTool = {
  name: slackBotPostReplyToolName,
  ...slackBotPostReplyToolMetadata
} as const;
