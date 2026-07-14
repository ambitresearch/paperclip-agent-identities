export const slackBotWhoamiToolName = "slack_bot_whoami";

// Empty params schema — no `channelId`, `agentId`, or credential ever
// accepted. See openwiki/domain/slack-provider-design.md §6.1.
export const slackBotWhoamiParametersSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} as const;

export const slackBotWhoamiToolMetadata = {
  displayName: "Slack Identity Who Am I",
  description:
    "Verifies the calling agent's Slack bot token via auth.test and returns the configured team/app/bot identity metadata. Never returns the token.",
  parametersSchema: slackBotWhoamiParametersSchema
} as const;

export const slackBotWhoamiManifestTool = {
  name: slackBotWhoamiToolName,
  ...slackBotWhoamiToolMetadata
} as const;
