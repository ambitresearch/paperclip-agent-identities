export const githubBotListOrganizationProjectsToolName = "github_bot_list_organization_projects";

export const githubBotListOrganizationProjectsToolMetadata = {
  displayName: "List Organization Projects (Agent Identity)",
  description:
    "Lists GitHub Projects v2 (org-level) for a GitHub organization using the configured agent identity, " +
    "optionally filtered by a search query. Requires the GitHub App to have the organization Projects " +
    "permission granted and accepted for the target installation.",
  parametersSchema: {
    type: "object",
    properties: {
      organization: {
        type: "string",
        description: "GitHub organization login to list Projects v2 for (e.g. \"my-org\")",
      },
      query: {
        type: "string",
        description: "Optional search string to filter projects by title",
      },
      first: {
        type: "number",
        description: "Maximum number of projects to return (default 20, max 100)",
      },
    },
    required: ["organization"],
  },
} as const;

export const githubBotListOrganizationProjectsManifestTool = {
  name: githubBotListOrganizationProjectsToolName,
  ...githubBotListOrganizationProjectsToolMetadata,
} as const;
