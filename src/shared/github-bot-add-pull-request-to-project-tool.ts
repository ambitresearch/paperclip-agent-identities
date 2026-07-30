export const githubBotAddPullRequestToProjectToolName = "github_bot_add_pull_request_to_project";

export const githubBotAddPullRequestToProjectToolMetadata = {
  displayName: "Add Pull Request To Project (Agent Identity)",
  description:
    "Adds a pull request as an item on a GitHub Projects v2 (org-level) board using the configured agent " +
    "identity, via the GitHub GraphQL Projects v2 API. Requires the GitHub App to have the organization " +
    "Projects permission granted and accepted for the target installation.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Repository the pull request lives in, in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to add to the project",
      },
      projectId: {
        type: "string",
        description: "The Projects v2 node ID (from github_bot_list_organization_projects) to add the pull request to",
      },
    },
    required: ["repository", "pullNumber", "projectId"],
  },
} as const;

export const githubBotAddPullRequestToProjectManifestTool = {
  name: githubBotAddPullRequestToProjectToolName,
  ...githubBotAddPullRequestToProjectToolMetadata,
} as const;
