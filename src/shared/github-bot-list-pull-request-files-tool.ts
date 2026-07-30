export const githubBotListPullRequestFilesToolName = "github_bot_list_pull_request_files";

export const githubBotListPullRequestFilesToolMetadata = {
  displayName: "List Pull Request Files (Agent Identity)",
  description:
    "Lists the files changed in a GitHub pull request (filename, status, additions, deletions, changes, " +
    "and patch when available) using the configured agent identity. A fresh per-agent GitHub App " +
    "installation token is minted for this read-only call. Supports pagination.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to list files for",
      },
      page: {
        type: "number",
        description: "Page number to fetch (1-indexed). Defaults to 1.",
      },
      perPage: {
        type: "number",
        description: "Number of files per page (max 100). Defaults to 30.",
      },
    },
    required: ["repository", "pullNumber"],
  },
} as const;

export const githubBotListPullRequestFilesManifestTool = {
  name: githubBotListPullRequestFilesToolName,
  ...githubBotListPullRequestFilesToolMetadata,
} as const;
