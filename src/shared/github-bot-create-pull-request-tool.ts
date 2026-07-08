export const githubBotCreatePullRequestToolName = "github_bot_create_pull_request";

export const githubBotCreatePullRequestToolMetadata = {
  displayName: "Create Pull Request (Agent Identity)",
  description:
    "Creates a GitHub pull request using the configured agent identity. " +
    "Only repositories matching the configured allowed repository patterns are permitted.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      head: {
        type: "string",
        description: "The name of the branch where your changes are implemented",
      },
      base: {
        type: "string",
        description: "The name of the branch you want the changes pulled into",
      },
      title: {
        type: "string",
        description: "The title of the pull request",
      },
      body: {
        type: "string",
        description: "The body/description of the pull request",
      },
      draft: {
        type: "boolean",
        description: "Whether to create the pull request as a draft",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this PR",
      },
    },
    required: ["repository", "head", "base", "title"],
  },
} as const;

export const githubBotCreatePullRequestManifestTool = {
  name: githubBotCreatePullRequestToolName,
  ...githubBotCreatePullRequestToolMetadata,
} as const;
