export const githubBotUpdatePullRequestToolName = "github_bot_update_pull_request";

export const githubBotUpdatePullRequestToolMetadata = {
  displayName: "Update Pull Request (Agent Identity)",
  description:
    "Updates a GitHub pull request's title, body, base branch, open/closed state, and/or draft/ready-for-" +
    "review state using the configured agent identity. An AI-authorship footer is appended server-side " +
    "to any non-empty `body` update; do not include your own authorship disclaimer in `body`.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to update",
      },
      title: {
        type: "string",
        description: "New pull request title",
      },
      body: {
        type: "string",
        description: "New pull request body (an AI-authorship footer is appended automatically when non-empty)",
      },
      base: {
        type: "string",
        description: "New base branch to retarget the pull request onto",
      },
      state: {
        type: "string",
        enum: ["open", "closed"],
        description: "Open or close the pull request",
      },
      draft: {
        type: "boolean",
        description: "Set true to convert to draft, false to mark ready for review",
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
    required: ["repository", "pullNumber"],
  },
} as const;

export const githubBotUpdatePullRequestManifestTool = {
  name: githubBotUpdatePullRequestToolName,
  ...githubBotUpdatePullRequestToolMetadata,
} as const;
