export const slackBotWhoamiToolName = "slack_bot_whoami";

export const slackBotWhoamiToolMetadata = {
  displayName: "Slack Identity Who Am I",
  description: "Returns the calling agent's configured Slack identity metadata.",
  parametersSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
} as const;

export const slackBotWhoamiManifestTool = {
  name: slackBotWhoamiToolName,
  ...slackBotWhoamiToolMetadata
} as const;
