export const GITHUB_BOT_PUSH_BRANCH_TOOL_NAME = "github_bot_push_branch";

export const githubBotPushBranchToolDefinition = {
  displayName: "Push Branch",
  description: "Push HEAD to a branch in an allowed roshangautam/* GitHub repository.",
  parametersSchema: {
    type: "object",
    additionalProperties: false,
    required: ["branch"],
    properties: {
      branch: { type: "string", minLength: 1, description: "Branch/ref to push; pushed to refs/heads/<branch> on the remote." },
      remote: { type: "string", description: "Git remote name used to resolve the target repository (defaults to \"origin\")." },
      expectedRepository: { type: "string", description: "Optional owner/repo or GitHub URL that must match the resolved remote before pushing." },
      dryRun: { type: "boolean", description: "When true, runs git push with --dry-run without updating the remote." }
    }
  }
} as const;
