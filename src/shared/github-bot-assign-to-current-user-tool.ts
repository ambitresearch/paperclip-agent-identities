export const githubBotAssignToCurrentUserToolName = "github_bot_assign_to_current_user";

export const githubBotAssignToCurrentUserToolMetadata = {
  displayName: "Assign To Current User (Agent Identity)",
  description:
    "Assigns a GitHub issue or pull request to the calling agent's configured GitHub App installation " +
    "identity, preserving any existing assignees. The assignee is always the agent's own configured " +
    "`githubUsername` — there is no `username` parameter, so this can never assign an arbitrary account " +
    "or silently fall back to a personal token.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      issueNumber: {
        type: "number",
        description: "The issue (or pull request) number to assign",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this assignment",
      },
    },
    required: ["repository", "issueNumber"],
  },
} as const;

export const githubBotAssignToCurrentUserManifestTool = {
  name: githubBotAssignToCurrentUserToolName,
  ...githubBotAssignToCurrentUserToolMetadata,
} as const;
