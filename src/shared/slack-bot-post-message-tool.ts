export const slackBotPostMessageToolName = "slack_bot_post_message";

const TEXT_MAX_LENGTH = 40_000;

export const slackBotPostMessageToolMetadata = {
  displayName: "Post Slack Message",
  description:
    "Posts a message to a Slack conversation using the calling agent's configured Slack bot " +
    "identity. The bot must already be a member of the target conversation -- Slack's own " +
    "membership ACL is the enforced authorization boundary, not a plugin-side allow-list.",
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
      text: {
        type: "string",
        description: "Message text. Required, must contain at least one non-whitespace character.",
        maxLength: TEXT_MAX_LENGTH
      },
      blocks: {
        type: "array",
        description:
          "Optional static Block Kit blocks (section/divider/header/context only -- no " +
          "interactive components, accessories, or images)."
      }
    },
    required: ["text"],
    additionalProperties: false
  }
} as const;

export const slackBotPostMessageManifestTool = {
  name: slackBotPostMessageToolName,
  ...slackBotPostMessageToolMetadata
} as const;
