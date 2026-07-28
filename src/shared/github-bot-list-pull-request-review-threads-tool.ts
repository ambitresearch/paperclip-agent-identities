export const githubBotListPullRequestReviewThreadsToolName = "github_bot_list_pull_request_review_threads";

export const githubBotListPullRequestReviewThreadsToolMetadata = {
  displayName: "List Pull Request Review Threads (Agent Identity)",
  description:
    "Lists a pull request's review threads (file paths, inline comments, and resolution state) using the " +
    "configured agent identity. Read-only -- does not mutate any thread.",
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
      first: {
        type: "number",
        description: "Maximum number of review threads to return (default 50, max 100)",
      },
    },
    required: ["repository", "pullNumber"],
  },
} as const;

export const githubBotListPullRequestReviewThreadsManifestTool = {
  name: githubBotListPullRequestReviewThreadsToolName,
  ...githubBotListPullRequestReviewThreadsToolMetadata,
} as const;
