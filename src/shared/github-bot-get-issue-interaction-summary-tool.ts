export const githubBotGetIssueInteractionSummaryToolName = "github_bot_get_issue_interaction_summary";

export const githubBotGetIssueInteractionSummaryToolMetadata = {
  displayName: "Get Issue Interaction Summary (Agent Identity)",
  description:
    "Returns a deterministic, sanitized summary of comment interactions recorded against a single " +
    "Paperclip issue, scoped to the calling agent's company. Paperclip-side only — this never calls " +
    "GitHub. Interactions are ordered ascending by creation time (tie-broken by comment id) so repeated " +
    "calls over the same window always return the same order. Comment bodies are truncated to 280 " +
    "characters and redacted for common secret shapes (GitHub tokens, OpenAI-style keys, PEM private " +
    "keys, bearer tokens) before being returned.",
  parametersSchema: {
    type: "object",
    properties: {
      issueId: {
        type: "string",
        description: "UUID of the Paperclip issue to summarise interactions for",
      },
      from: {
        type: "string",
        description: "Optional ISO 8601 UTC start of the window, inclusive. Defaults to unbounded.",
      },
      to: {
        type: "string",
        description:
          "Optional ISO 8601 UTC end of the window, exclusive ([from, to)). Defaults to unbounded. " +
          "When both from and to are given, the window must not exceed 30 days.",
      },
    },
    required: ["issueId"],
  },
} as const;

export const githubBotGetIssueInteractionSummaryManifestTool = {
  name: githubBotGetIssueInteractionSummaryToolName,
  ...githubBotGetIssueInteractionSummaryToolMetadata,
} as const;
