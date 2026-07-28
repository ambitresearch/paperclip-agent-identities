export const githubBotUnresolveReviewThreadToolName = "github_bot_unresolve_review_thread";

export const githubBotUnresolveReviewThreadToolMetadata = {
  displayName: "Unresolve Review Thread (Agent Identity)",
  description:
    "Reopens (marks unresolved) a previously-resolved GitHub pull request review thread using the " +
    "configured agent identity. A fresh per-agent GitHub App installation token is minted for this call.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      reviewThreadId: {
        type: "string",
        description: "The GraphQL node ID of the review thread to unresolve (from List Pull Request Review Threads)",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this action",
      },
    },
    required: ["repository", "reviewThreadId"],
  },
} as const;

export const githubBotUnresolveReviewThreadManifestTool = {
  name: githubBotUnresolveReviewThreadToolName,
  ...githubBotUnresolveReviewThreadToolMetadata,
} as const;
