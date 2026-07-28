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

// Namespace + key for the plugin-state row that stores every GitHub link for
// a given Paperclip issue. Scoped to `scopeKind: "issue"` (see ScopeKey in
// @paperclipai/plugin-sdk) so storage lives independently of any
// project-repo mapping -- this is exactly what DRO-1170 asks for: linking
// works even when the target repository is not mapped to a Paperclip
// project. One state row per issue holds an array of link records; this
// keeps reads/writes to a single get+set round trip per call instead of one
// row per link.
const LINKS_NAMESPACE = "github-links";
const LINKS_STATE_KEY = "links";
const MAX_LINKS_PER_ISSUE = 200;

export interface GitHubItemLinkRecord {
  githubUrl: string;
  note: string | null;
  linkedByAgentId: string;
  linkedAt: string;
}

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

function isLinkRecordArray(value: unknown): value is GitHubItemLinkRecord[] {
  return Array.isArray(value);
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

    const scopeKey = {
      scopeKind: "issue" as const,
      scopeId: validated.paperclipIssueId,
      namespace: LINKS_NAMESPACE,
      stateKey: LINKS_STATE_KEY
    };

    let existing: GitHubItemLinkRecord[] = [];
    try {
      const raw = await ctx.state.get(scopeKey);
      if (isLinkRecordArray(raw)) {
        existing = raw;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown storage error";
      ctx.logger.error(`github_bot_link_github_item failed to read existing links: ${reason}`);
      return { error: "Failed to read existing GitHub links before linking." };
    }

    const now = new Date().toISOString();
    const record: GitHubItemLinkRecord = {
      githubUrl: validated.githubUrl,
      note: validated.note ?? null,
      linkedByAgentId: runCtx.agentId,
      linkedAt: now
    };

    const withoutDuplicate = existing.filter((link) => link.githubUrl !== validated.githubUrl);
    const next = [...withoutDuplicate, record].slice(-MAX_LINKS_PER_ISSUE);

    try {
      await ctx.state.set(scopeKey, next);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown storage error";
      ctx.logger.error(`github_bot_link_github_item failed to persist link: ${reason}`);
      return { error: "Failed to persist the GitHub link." };
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
        note: record.note,
        linkedAt: record.linkedAt,
        totalLinks: next.length
      }
    };
  }
};
