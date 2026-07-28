export const githubBotRequestPullRequestReviewersToolName = "github_bot_request_pull_request_reviewers";

export const githubBotRequestPullRequestReviewersToolMetadata = {
  displayName: "Request Pull Request Reviewers (Agent Identity)",
  description:
    "Requests reviewers (users and/or teams) on a pull request using the configured agent identity. A fresh " +
    "per-agent GitHub App installation token is minted for this call; repository access is scoped by the " +
    "GitHub App installation permissions. Use this for the sanctioned agent-chain review routing described in " +
    "company policy -- do not request reviews from a human board user through this tool for routine PR gates.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to request reviewers on",
      },
      reviewers: {
        type: "array",
        description: "GitHub usernames to request as reviewers",
        items: { type: "string" },
      },
      teamReviewers: {
        type: "array",
        description: "Team slugs (within the repository's organization) to request as reviewers",
        items: { type: "string" },
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this request",
      },
    },
    required: ["repository", "pullNumber"],
  },
} as const;

export const githubBotRequestPullRequestReviewersManifestTool = {
  name: githubBotRequestPullRequestReviewersToolName,
  ...githubBotRequestPullRequestReviewersToolMetadata,
} as const;
