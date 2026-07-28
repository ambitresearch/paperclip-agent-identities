export const githubBotReplyToReviewThreadToolName = "github_bot_reply_to_review_thread";

export const githubBotReplyToReviewThreadToolMetadata = {
  displayName: "Reply To Review Thread (Agent Identity)",
  description:
    "Replies to an existing GitHub pull request review thread (a threaded inline review comment) using " +
    "the configured agent identity. A fresh per-agent GitHub App installation token is minted for this " +
    "call. An AI-authorship footer is appended server-side; do not include your own authorship disclaimer " +
    "in `body`.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      reviewThreadId: {
        type: "string",
        description: "The GraphQL node ID of the review thread to reply to (from List Pull Request Review Threads)",
      },
      body: {
        type: "string",
        description: "The human-facing reply text (an AI-authorship footer is appended automatically)",
      },
      llmModel: {
        type: "string",
        description: "Optional model identifier included in the appended authorship footer",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this reply",
      },
    },
    required: ["repository", "reviewThreadId", "body"],
  },
} as const;

export const githubBotReplyToReviewThreadManifestTool = {
  name: githubBotReplyToReviewThreadToolName,
  ...githubBotReplyToReviewThreadToolMetadata,
} as const;
