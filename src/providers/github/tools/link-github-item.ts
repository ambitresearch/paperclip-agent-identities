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
import { persistGithubLink } from "../link-storage.js";
export type { GitHubItemLinkRecord } from "../link-storage.js";

export interface LinkGithubItemParams {
  paperclipIssueId: string;
  githubUrl: string;
  note?: string;
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
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(p.githubUrl);
  } catch {
    return { ok: false, error: "githubUrl must be a valid absolute URL" };
  }
  if (parsedUrl.hostname.toLowerCase() !== "github.com") {
    return { ok: false, error: "githubUrl must be a github.com URL" };
  }
  if (p.note !== undefined && typeof p.note !== "string") {
    return { ok: false, error: "note must be a string if provided" };
  }
  if (p.llmModel !== undefined && typeof p.llmModel !== "string") {
    return { ok: false, error: "llmModel must be a string if provided" };
  }
  const validated: LinkGithubItemParams = {
    paperclipIssueId: p.paperclipIssueId,
    githubUrl: p.githubUrl,
    note: typeof p.note === "string" ? p.note : undefined,
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
    const runCtx = execution.runCtx;
    const validated = execution.params as LinkGithubItemParams;

    const result = await persistGithubLink({
      ctx,
      runCtx,
      paperclipIssueId: validated.paperclipIssueId,
      githubUrl: validated.githubUrl,
      note: validated.note
    });

    if (!result.ok || !result.record) {
      ctx.logger.error(`github_bot_link_github_item failed: ${result.error ?? "unknown error"}`);
      return { error: result.error ?? "Failed to persist the GitHub link." };
    }

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Linked issue ${validated.paperclipIssueId} to ${validated.githubUrl}`,
      entityType: "issue",
      entityId: validated.paperclipIssueId,
      metadata: {
        githubUrl: validated.githubUrl,
        agentId: runCtx.agentId,
        ...(validated.llmModel ? { llmModel: validated.llmModel } : {})
      }
    });
    ctx.logger.info(`Linked Paperclip issue ${validated.paperclipIssueId} to ${validated.githubUrl}`);

    return {
      content: `Linked Paperclip issue ${validated.paperclipIssueId} to ${validated.githubUrl}`,
      data: {
        paperclipIssueId: validated.paperclipIssueId,
        githubUrl: validated.githubUrl,
        note: result.record.note,
        linkedAt: result.record.linkedAt,
        totalLinks: result.totalLinks
      }
    };
  }
};
