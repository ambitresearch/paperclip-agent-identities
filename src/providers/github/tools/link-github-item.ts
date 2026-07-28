import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import type { ResourceReference } from "../../../core/resource-reference.js";
import {
  githubBotLinkGithubItemToolMetadata,
  githubBotLinkGithubItemToolName
} from "../../../shared/github-bot-link-github-item-tool.js";

export interface LinkGithubItemParams {
  paperclipIssueId: string;
  githubUrl: string;
  llmModel?: string;
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.paperclipIssueId || typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId is required" };
  }
  if (!p.githubUrl || typeof p.githubUrl !== "string") {
    return { ok: false, error: "githubUrl is required" };
  }
  const validated: LinkGithubItemParams = {
    paperclipIssueId: p.paperclipIssueId,
    githubUrl: p.githubUrl,
    llmModel: typeof p.llmModel === "string" ? p.llmModel : undefined
  };
  return { ok: true, params: validated };
}

export const githubLinkGithubItemToolSpec: ProviderToolSpec<GitHubAgentIdentity, ResourceReference> = {
  name: githubBotLinkGithubItemToolName,
  metadata: githubBotLinkGithubItemToolMetadata,
  requiresCredential: false,
  validateParams,
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, ResourceReference>
  ): Promise<unknown> {
    const ctx = execution.ctx;
    const validated = execution.params as LinkGithubItemParams;

    ctx.logger.info(`github_bot_link_github_item called for issue ${validated.paperclipIssueId} → ${validated.githubUrl} (stub — pending DRO-1166)`);

    // Full implementation requires DRO-1166 which will expose a Paperclip API
    // client on PluginContext that can create issue links. Until then, return a
    // stub response.
    return {
      content:
        "GitHub item linking is not yet available. " +
        "This tool requires DRO-1166 (Paperclip API client in PluginContext) to create issue links. " +
        `Requested link: Paperclip issue ${validated.paperclipIssueId} → ${validated.githubUrl}`,
      data: {
        stub: true,
        paperclipIssueId: validated.paperclipIssueId,
        githubUrl: validated.githubUrl,
        llmModel: validated.llmModel ?? null,
        pendingTicket: "DRO-1166"
      }
    };
  }
};
