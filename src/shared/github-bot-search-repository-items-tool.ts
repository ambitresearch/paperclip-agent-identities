export const githubBotSearchRepositoryItemsToolName = "github_bot_search_repository_items";

export const githubBotSearchRepositoryItemsToolMetadata = {
  displayName: "Search Repository Items (Agent Identity)",
  description:
    "Searches issues or pull requests in a GitHub repository using the GitHub search API. " +
    "Returns a ranked list of matching items with their number, title, state, URL, labels, and assignees.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: 'Target repository in owner/repo format (e.g. "my-org/my-repo")',
      },
      query: {
        type: "string",
        description: "Search query string (e.g. \"bug label:critical\")",
      },
      type: {
        type: "string",
        enum: ["issue", "pr"],
        description: "Whether to search issues or pull requests (default: \"issue\")",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return, between 1 and 30 (default: 10)",
      },
    },
    required: ["repository", "query"],
  },
} as const;

export const githubBotSearchRepositoryItemsManifestTool = {
  name: githubBotSearchRepositoryItemsToolName,
  ...githubBotSearchRepositoryItemsToolMetadata,
} as const;
