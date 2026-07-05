export const githubBotWhoamiToolName = "github_bot_whoami";

export const githubBotWhoamiToolMetadata = {
  displayName: "GitHub Bot Who Am I",
  description: "Returns the calling agent's configured GitHub bot identity metadata.",
  parametersSchema: {
    type: "object",
    properties: {},
    additionalProperties: false
  }
} as const;

export const githubBotWhoamiManifestTool = {
  name: githubBotWhoamiToolName,
  ...githubBotWhoamiToolMetadata
} as const;
