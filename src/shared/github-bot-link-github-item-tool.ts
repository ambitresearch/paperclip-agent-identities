export const githubBotLinkGithubItemToolName = "github_bot_link_github_item";

export const githubBotLinkGithubItemToolMetadata = {
  displayName: "Link GitHub Item (Agent Identity)",
  description:
    "Creates a link between a Paperclip issue and a GitHub item (issue or pull request URL). " +
    "Note: full implementation requires DRO-1166 (Paperclip API client in PluginContext).",
  parametersSchema: {
    type: "object",
    properties: {
      paperclipIssueId: {
        type: "string",
        description: "UUID of the Paperclip issue to link from",
      },
      githubUrl: {
        type: "string",
        description: "Full GitHub URL of the issue or pull request to link to",
      },
      llmModel: {
        type: "string",
        description: "Optional model identifier to include in activity metadata",
      },
    },
    required: ["paperclipIssueId", "githubUrl"],
  },
} as const;

export const githubBotLinkGithubItemManifestTool = {
  name: githubBotLinkGithubItemToolName,
  ...githubBotLinkGithubItemToolMetadata,
} as const;
