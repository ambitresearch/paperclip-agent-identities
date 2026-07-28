export const githubBotAddIssueCommentToolName = "github_bot_add_issue_comment";

export const githubBotAddIssueCommentToolMetadata = {
  displayName: "Add Issue Comment (Agent Identity)",
  description:
    "Posts a comment on a GitHub issue (or pull request, which GitHub treats as an issue for comments) " +
    "using the configured agent identity. A fresh per-agent GitHub App installation token is minted for " +
    "this call. An AI-authorship footer is appended server-side; do not include your own authorship " +
    "disclaimer in `body`.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      issueNumber: {
        type: "number",
        description: "The issue (or pull request) number to comment on",
      },
      body: {
        type: "string",
        description: "The human-facing comment text (an AI-authorship footer is appended automatically)",
      },
      llmModel: {
        type: "string",
        description: "Optional model identifier included in the appended authorship footer",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this comment",
      },
    },
    required: ["repository", "issueNumber", "body"],
  },
} as const;

export const githubBotAddIssueCommentManifestTool = {
  name: githubBotAddIssueCommentToolName,
  ...githubBotAddIssueCommentToolMetadata,
} as const;
