export const githubBotGetIssueToolName = "github_bot_get_issue";

export const githubBotGetIssueToolMetadata = {
  displayName: "Get Issue (Agent Identity)",
  description:
    "Fetches a single GitHub issue's core fields (title, body, state, assignees, labels, milestone) using " +
    "the configured agent identity. A fresh per-agent GitHub App installation token is minted for this " +
    "read-only call.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      issueNumber: {
        type: "number",
        description: "The issue number to fetch",
      },
    },
    required: ["repository", "issueNumber"],
  },
} as const;

export const githubBotGetIssueManifestTool = {
  name: githubBotGetIssueToolName,
  ...githubBotGetIssueToolMetadata,
} as const;
