export const githubBotListIssueCommentsToolName = "github_bot_list_issue_comments";

export const githubBotListIssueCommentsToolMetadata = {
  displayName: "List Issue Comments (Agent Identity)",
  description:
    "Lists comments on a GitHub issue (or pull request) using the configured agent identity. A fresh " +
    "per-agent GitHub App installation token is minted for this read-only call. Supports pagination.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      issueNumber: {
        type: "number",
        description: "The issue (or pull request) number to list comments for",
      },
      page: {
        type: "number",
        description: "Page number to fetch (1-indexed). Defaults to 1.",
      },
      perPage: {
        type: "number",
        description: "Number of comments per page (max 100). Defaults to 30.",
      },
    },
    required: ["repository", "issueNumber"],
  },
} as const;

export const githubBotListIssueCommentsManifestTool = {
  name: githubBotListIssueCommentsToolName,
  ...githubBotListIssueCommentsToolMetadata,
} as const;
