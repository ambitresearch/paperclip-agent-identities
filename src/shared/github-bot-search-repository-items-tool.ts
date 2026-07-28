export const githubBotSearchRepositoryItemsToolName = "github_bot_search_repository_items";

export const githubBotSearchRepositoryItemsToolMetadata = {
  displayName: "Search Repository Items (Agent Identity)",
  description:
    "Searches issues or pull requests in a GitHub repository using the GitHub search API (for triage " +
    "and dedup workflows). Returns a bounded, sanitized list of matching items with their number, " +
    "title, state, URL, labels, and assignees. Supports pagination via `page`.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: 'Target repository in owner/repo format (e.g. "my-org/my-repo")',
      },
      query: {
        type: "string",
        description: "Search query string (e.g. \"bug label:critical\"), up to 256 characters",
      },
      type: {
        type: "string",
        enum: ["issue", "pr"],
        description: "Whether to search issues or pull requests (default: \"issue\")",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of results to return per page, between 1 and 30 (default: 10)",
      },
      page: {
        type: "number",
        description: "Page number to fetch (1-indexed). Defaults to 1.",
      },
    },
    required: ["repository", "query"],
  },
} as const;

export const githubBotSearchRepositoryItemsManifestTool = {
  name: githubBotSearchRepositoryItemsToolName,
  ...githubBotSearchRepositoryItemsToolMetadata,
} as const;
