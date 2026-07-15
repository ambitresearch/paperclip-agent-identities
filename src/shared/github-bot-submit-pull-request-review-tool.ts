export const githubBotSubmitPullRequestReviewToolName = "github_bot_submit_pull_request_review";

export const githubBotSubmitPullRequestReviewToolMetadata = {
  displayName: "Submit Pull Request Review (Agent Identity)",
  description:
    "Submits a real GitHub App pull request review (APPROVE, REQUEST_CHANGES, or COMMENT) using the " +
    "configured agent identity. A fresh per-agent GitHub App installation token is minted for this call; " +
    "repository access is scoped by the GitHub App installation permissions. This is the sanctioned path " +
    "for routine PR review policy -- do not submit reviews via GitHub Sync, raw GitHub API calls, `gh`, or " +
    "any stored personal token.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to review",
      },
      event: {
        type: "string",
        enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
        description: "The review decision to submit",
      },
      body: {
        type: "string",
        description: "The overall review body/summary. Required unless comments are provided.",
      },
      comments: {
        type: "array",
        description: "Optional inline review comments anchored to a file and line in the diff",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "File path (relative to repo root) the comment applies to",
            },
            line: {
              type: "number",
              description: "Line number in the diff's right-hand side (new file version) to anchor the comment",
            },
            body: {
              type: "string",
              description: "The inline comment text",
            },
          },
          required: ["path", "line", "body"],
        },
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this review",
      },
    },
    required: ["repository", "pullNumber", "event"],
  },
} as const;

export const githubBotSubmitPullRequestReviewManifestTool = {
  name: githubBotSubmitPullRequestReviewToolName,
  ...githubBotSubmitPullRequestReviewToolMetadata,
} as const;
