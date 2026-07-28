import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import type { ResourceReference } from "../../../core/resource-reference.js";
import {
  githubBotGetIssueInteractionSummaryToolMetadata,
  githubBotGetIssueInteractionSummaryToolName
} from "../../../shared/github-bot-get-issue-interaction-summary-tool.js";

export interface GetIssueInteractionSummaryParams {
  issueId: string;
  from?: string;
  to?: string;
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.issueId || typeof p.issueId !== "string") {
    return { ok: false, error: "issueId is required" };
  }
  if (p.from !== undefined && typeof p.from !== "string") {
    return { ok: false, error: "from must be an ISO 8601 date string" };
  }
  if (p.to !== undefined && typeof p.to !== "string") {
    return { ok: false, error: "to must be an ISO 8601 date string" };
  }
  const validated: GetIssueInteractionSummaryParams = {
    issueId: p.issueId,
    from: typeof p.from === "string" ? p.from : undefined,
    to: typeof p.to === "string" ? p.to : undefined
  };
  return { ok: true, params: validated };
}

export const githubGetIssueInteractionSummaryToolSpec: ProviderToolSpec<GitHubAgentIdentity, ResourceReference> = {
  name: githubBotGetIssueInteractionSummaryToolName,
  metadata: githubBotGetIssueInteractionSummaryToolMetadata,
  requiresCredential: false,
  validateParams,
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, ResourceReference>
  ): Promise<unknown> {
    const ctx = execution.ctx;
    const validated = execution.params as GetIssueInteractionSummaryParams;

    ctx.logger.info(`github_bot_get_issue_interaction_summary called for issue ${validated.issueId} (stub — pending DRO-1166)`);

    // Full implementation requires DRO-1166 which will expose a Paperclip API
    // client on PluginContext. Until then, return a stub response.
    return {
      content:
        "Issue interaction summary is not yet available. " +
        "This tool requires DRO-1166 (Paperclip API client in PluginContext) to retrieve interaction data. " +
        `Requested issueId: ${validated.issueId}` +
        (validated.from ? `, from: ${validated.from}` : "") +
        (validated.to ? `, to: ${validated.to}` : ""),
      data: {
        stub: true,
        issueId: validated.issueId,
        from: validated.from ?? null,
        to: validated.to ?? null,
        pendingTicket: "DRO-1166"
      }
    };
  }
};
