export const githubBotGetPullRequestChecksToolName = "github_bot_get_pull_request_checks";

export const githubBotGetPullRequestChecksToolMetadata = {
  displayName: "Get Pull Request Checks (Agent Identity)",
  description:
    "Reads the CI/CD status of a pull request's head commit using the configured agent identity: check runs " +
    "(GitHub Actions and other Checks-API integrations), legacy commit status contexts, and the workflow runs " +
    "associated with the head SHA. Read-only -- does not mutate the pull request or any check.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to inspect",
      },
    },
    required: ["repository", "pullNumber"],
  },
} as const;

export const githubBotGetPullRequestChecksManifestTool = {
  name: githubBotGetPullRequestChecksToolName,
  ...githubBotGetPullRequestChecksToolMetadata,
} as const;
