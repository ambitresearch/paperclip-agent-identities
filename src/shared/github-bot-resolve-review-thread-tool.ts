export const githubBotResolveReviewThreadToolName = "github_bot_resolve_review_thread";

export const githubBotResolveReviewThreadToolMetadata = {
  displayName: "Resolve Review Thread (Agent Identity)",
  description:
    "Marks a GitHub pull request review thread as resolved using the configured agent identity. A fresh " +
    "per-agent GitHub App installation token is minted for this call.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      reviewThreadId: {
        type: "string",
        description: "The GraphQL node ID of the review thread to resolve (from List Pull Request Review Threads)",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this action",
      },
    },
    required: ["repository", "reviewThreadId"],
  },
} as const;

export const githubBotResolveReviewThreadManifestTool = {
  name: githubBotResolveReviewThreadToolName,
  ...githubBotResolveReviewThreadToolMetadata,
} as const;
