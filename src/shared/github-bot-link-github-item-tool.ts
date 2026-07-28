export const githubBotLinkGithubItemToolName = "github_bot_link_github_item";

export const githubBotLinkGithubItemToolMetadata = {
  displayName: "Link GitHub Item (Agent Identity)",
  description:
    "Links a Paperclip issue to a GitHub issue or pull request URL, even when the target repository " +
    "is not mapped to a Paperclip project. The link is stored in Paperclip plugin state, scoped to the " +
    "Paperclip issue, independent of any project-repo mapping. Links are additive: linking the same " +
    "githubUrl again updates its recorded note/timestamp rather than creating a duplicate entry. " +
    "Use github_bot_get_issue or github_bot_get_pull_request separately to verify the target still " +
    "exists on GitHub.",
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
      note: {
        type: "string",
        description: "Optional free-text note describing why this link exists",
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
