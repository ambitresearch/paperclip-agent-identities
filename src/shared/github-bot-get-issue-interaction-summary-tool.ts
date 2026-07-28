export const githubBotGetIssueInteractionSummaryToolName = "github_bot_get_issue_interaction_summary";

export const githubBotGetIssueInteractionSummaryToolMetadata = {
  displayName: "Get Issue Interaction Summary (Agent Identity)",
  description:
    "Returns a summary of agent interactions recorded against a Paperclip issue. " +
    "Optionally filters by a date range. " +
    "Note: full implementation requires DRO-1166 (Paperclip API client in PluginContext).",
  parametersSchema: {
    type: "object",
    properties: {
      issueId: {
        type: "string",
        description: "UUID of the Paperclip issue to summarise interactions for",
      },
      from: {
        type: "string",
        description: "Optional ISO 8601 start date for the filter range (inclusive)",
      },
      to: {
        type: "string",
        description: "Optional ISO 8601 end date for the filter range (inclusive)",
      },
    },
    required: ["issueId"],
  },
} as const;

export const githubBotGetIssueInteractionSummaryManifestTool = {
  name: githubBotGetIssueInteractionSummaryToolName,
  ...githubBotGetIssueInteractionSummaryToolMetadata,
} as const;
