export const githubBotCreatePullRequestToolName = "github_bot_create_pull_request";

export const githubBotCreatePullRequestToolMetadata = {
  displayName: "Create Pull Request (Agent Identity)",
  description:
    "Creates a GitHub pull request using the configured agent identity. " +
    "Repository access is controlled by the provider credential and GitHub App installation permissions.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      head: {
        type: "string",
        description: "The name of the branch where your changes are implemented",
      },
      base: {
        type: "string",
        description: "The name of the branch you want the changes pulled into",
      },
      title: {
        type: "string",
        description: "The title of the pull request",
      },
      body: {
        type: "string",
        description: "The body/description of the pull request",
      },
      draft: {
        type: "boolean",
        description: "Whether to create the pull request as a draft",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this PR",
      },
      remote: {
        type: "string",
        description:
          "Optional local git remote name to publish `head` from (default \"origin\"). Only used when `commit` is provided.",
      },
      commit: {
        type: "string",
        description:
          "Optional exact local commit SHA to publish as `head` before creating the PR. When provided, the local " +
          "workspace HEAD must already be at this commit; the branch is pushed at this exact commit, verified on " +
          "the remote, and rolled back if PR creation subsequently fails.",
      },
      dryRun: {
        type: "boolean",
        description: "When true and `commit` is provided, performs a dry-run push and returns without creating a PR.",
      },
    },
    required: ["repository", "head", "base", "title"],
  },
} as const;

export const githubBotCreatePullRequestManifestTool = {
  name: githubBotCreatePullRequestToolName,
  ...githubBotCreatePullRequestToolMetadata,
} as const;
