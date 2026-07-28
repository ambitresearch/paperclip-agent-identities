export const GITHUB_BOT_PUSH_BRANCH_TOOL_NAME = "github_bot_push_branch";

export const githubBotPushBranchToolDefinition = {
  displayName: "Push Branch",
  description: "Push HEAD to a branch in a GitHub repository using the configured agent identity.",
  parametersSchema: {
    type: "object",
    additionalProperties: false,
    required: ["branch"],
    properties: {
      branch: { type: "string", minLength: 1, description: "Branch/ref to push; pushed to refs/heads/<branch> on the remote." },
      remote: { type: "string", description: "Git remote name used to resolve the target repository (defaults to \"origin\")." },
      expectedRepository: { type: "string", description: "Optional owner/repo or GitHub URL that must match the resolved remote before pushing." },
      dryRun: { type: "boolean", description: "When true, runs git push with --dry-run without updating the remote." },
      expectedCurrentSha: {
        type: "string",
        pattern: "^[0-9a-fA-F]{40}$",
        description: "Optional full 40-character hex commit SHA the caller believes is the branch's current remote tip. When set, the push runs as a ref-scoped 'git push --force-with-lease=refs/heads/<branch>:<expectedCurrentSha>' instead of a plain push, so a diverged remote (tip != expectedCurrentSha) rejects the push instead of being overwritten. Omit for a normal, non-force push."
      }
    }
  }
} as const;

export const githubBotPushBranchManifestTool = {
  name: GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  ...githubBotPushBranchToolDefinition
} as const;
