export const githubBotUpdateIssueToolName = "github_bot_update_issue";

export const githubBotUpdateIssueToolMetadata = {
  displayName: "Update Issue (Agent Identity)",
  description:
    "Updates a GitHub issue's title, body, state, labels, assignees, or milestone using the configured " +
    "agent identity. A fresh per-agent GitHub App installation token is minted for this call. An " +
    "AI-authorship footer is appended to `body` when provided; do not include your own authorship " +
    "disclaimer in `body`. At least one updatable field must be provided.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      issueNumber: {
        type: "number",
        description: "The issue number to update",
      },
      title: {
        type: "string",
        description: "New issue title",
      },
      body: {
        type: "string",
        description: "New issue body (an AI-authorship footer is appended automatically)",
      },
      state: {
        type: "string",
        enum: ["open", "closed"],
        description: "New issue state",
      },
      stateReason: {
        type: "string",
        description: "Reason for the state change (e.g. \"completed\", \"not_planned\", \"reopened\")",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Replacement set of label names",
      },
      assignees: {
        type: "array",
        items: { type: "string" },
        description: "Replacement set of assignee usernames",
      },
      milestone: {
        type: "number",
        description: "Milestone number to set, or null to clear",
      },
      llmModel: {
        type: "string",
        description: "Optional model identifier included in the appended authorship footer",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this update",
      },
    },
    required: ["repository", "issueNumber"],
  },
} as const;

export const githubBotUpdateIssueManifestTool = {
  name: githubBotUpdateIssueToolName,
  ...githubBotUpdateIssueToolMetadata,
} as const;
