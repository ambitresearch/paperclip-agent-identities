export const githubBotGetPullRequestToolName = "github_bot_get_pull_request";

export const githubBotGetPullRequestToolMetadata = {
  displayName: "Get Pull Request (Agent Identity)",
  description:
    "Fetches a single GitHub pull request's core fields (title, body, state, head/base branches, draft, " +
    "merged, mergeable state, requested reviewers) using the configured agent identity. A fresh per-agent " +
    "GitHub App installation token is minted for this read-only call.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to fetch",
      },
    },
    required: ["repository", "pullNumber"],
  },
} as const;

export const githubBotGetPullRequestManifestTool = {
  name: githubBotGetPullRequestToolName,
  ...githubBotGetPullRequestToolMetadata,
} as const;
