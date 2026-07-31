export const githubBotMergePullRequestToolName = "github_bot_merge_pull_request";

export const githubBotMergePullRequestToolMetadata = {
  displayName: "Merge Pull Request (Agent Identity)",
  description:
    "Merges a pull request using the configured agent identity, completing the routine PR lifecycle " +
    "without a board handoff. A fresh per-agent GitHub App installation token is minted for this call. " +
    "The merge gate is enforced server-side and fails closed: the pull request must be open, not a draft, " +
    "mergeable, carry at least two approving reviews from distinct non-author reviewers on the *current* " +
    "head commit, have no reviewer requesting changes, have zero unresolved review threads, and have no " +
    "failing or pending checks. The caller may not be the pull request author. The observed head SHA is " +
    "pinned on the merge request, so a push racing the gate check aborts the merge instead of merging " +
    "unreviewed code. Note: distinct-reviewer identity is verified, but reviewer *model* diversity is a " +
    "policy convention this wrapper cannot observe through the GitHub API. This is the sanctioned path " +
    "for merging -- do not merge via GitHub Sync, raw GitHub API calls, `gh`, or any stored personal token.",
  parametersSchema: {
    type: "object",
    properties: {
      repository: {
        type: "string",
        description: "Target repository in owner/repo format (e.g. \"my-org/my-repo\")",
      },
      pullNumber: {
        type: "number",
        description: "The pull request number to merge",
      },
      mergeMethod: {
        type: "string",
        enum: ["merge", "squash", "rebase"],
        description: "How to merge. Defaults to \"squash\".",
      },
      commitTitle: {
        type: "string",
        description: "Optional title for the merge/squash commit. GitHub generates one when omitted.",
      },
      commitBody: {
        type: "string",
        description: "Optional body for the merge/squash commit. GitHub generates one when omitted.",
      },
      expectedHeadSha: {
        type: "string",
        description:
          "Optional full 40-character head commit SHA the caller believes it reviewed. When it does not " +
          "match the pull request's current head, the merge is refused and the mismatch is reported " +
          "alongside every other gate blocker, so one call surfaces everything that needs fixing.",
      },
      paperclipIssueId: {
        type: "string",
        description: "Optional Paperclip issue ID to associate with this merge",
      },
    },
    required: ["repository", "pullNumber"],
  },
} as const;

export const githubBotMergePullRequestManifestTool = {
  name: githubBotMergePullRequestToolName,
  ...githubBotMergePullRequestToolMetadata,
} as const;
