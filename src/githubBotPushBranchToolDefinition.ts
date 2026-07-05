export const GITHUB_BOT_PUSH_BRANCH_TOOL_NAME = "github_bot_push_branch";

export const githubBotPushBranchToolDefinition = {
  displayName: "Push Branch",
  description: "Push HEAD to a branch in an allowed roshangautam/* GitHub repository.",
  parametersSchema: {
    type: "object",
    additionalProperties: false,
    required: ["branch"],
    properties: {
      branch: { type: "string", minLength: 1 },
      remote: { type: "string" },
      expectedRepository: { type: "string" },
      dryRun: { type: "boolean" }
    }
  }
} as const;
