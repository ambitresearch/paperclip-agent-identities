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

// The window is bounded to a maximum of 30 days to keep this a cheap,
// deterministic summary rather than an open-ended export. `to` is exclusive
// ([from, to)) so adjacent windows never double-count a comment landing
// exactly on a boundary timestamp.
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

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

  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (p.from !== undefined) {
    fromMs = Date.parse(p.from as string);
    if (Number.isNaN(fromMs)) {
      return { ok: false, error: "from must be a valid ISO 8601 date string" };
    }
  }
  if (p.to !== undefined) {
    toMs = Date.parse(p.to as string);
    if (Number.isNaN(toMs)) {
      return { ok: false, error: "to must be a valid ISO 8601 date string" };
    }
  }
  if (fromMs !== undefined && toMs !== undefined) {
    if (toMs <= fromMs) {
      return { ok: false, error: "to must be strictly after from" };
    }
    if (toMs - fromMs > MAX_WINDOW_MS) {
      return { ok: false, error: "the [from, to) window must not exceed 30 days" };
    }
  }

  const validated: GetIssueInteractionSummaryParams = {
    issueId: p.issueId,
    from: typeof p.from === "string" ? p.from : undefined,
    to: typeof p.to === "string" ? p.to : undefined
  };
  return { ok: true, params: validated };
}

interface InteractionSummaryEntry {
  kind: "comment";
  id: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: string;
  bodyPreview: string;
}

const BODY_PREVIEW_MAX_CHARS = 280;

// Deterministic, best-effort redaction of common secret shapes so a summary
// intended for cross-surface (e.g. GitHub) consumption never leaks tokens
// that happened to be pasted into a Paperclip issue comment.
function sanitizeBody(body: string): string {
  let sanitized = body
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9]{16,}\b/g, "[REDACTED]")
    .replace(/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi, "Bearer [REDACTED]");
  if (sanitized.length > BODY_PREVIEW_MAX_CHARS) {
    sanitized = `${sanitized.slice(0, BODY_PREVIEW_MAX_CHARS)}…`;
  }
  return sanitized;
}

function toEpochMs(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
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
    const runCtx = execution.runCtx;
    const validated = execution.params as GetIssueInteractionSummaryParams;

    const issue = await ctx.issues.get(validated.issueId, runCtx.companyId);
    if (!issue) {
      return { error: `Paperclip issue ${validated.issueId} was not found in this company.` };
    }

    const fromMs = validated.from !== undefined ? Date.parse(validated.from) : undefined;
    const toMs = validated.to !== undefined ? Date.parse(validated.to) : undefined;

    let comments;
    try {
      comments = await ctx.issues.listComments(validated.issueId, runCtx.companyId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      ctx.logger.error(`github_bot_get_issue_interaction_summary failed to list comments: ${reason}`);
      return { error: "Failed to read Paperclip issue comments." };
    }

    const inWindow = comments.filter((comment) => {
      if (comment.deletedAt) return false;
      const createdMs = toEpochMs(comment.createdAt);
      if (fromMs !== undefined && createdMs < fromMs) return false;
      if (toMs !== undefined && createdMs >= toMs) return false;
      return true;
    });

    // Deterministic ordering: ascending by createdAt, tie-broken by comment id
    // so repeated calls over the same window always return the same order
    // regardless of storage/read-replica ordering.
    inWindow.sort((a, b) => {
      const diff = toEpochMs(a.createdAt) - toEpochMs(b.createdAt);
      if (diff !== 0) return diff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const entries: InteractionSummaryEntry[] = inWindow.map((comment) => ({
      kind: "comment",
      id: comment.id,
      authorAgentId: comment.authorAgentId,
      authorUserId: comment.authorUserId,
      createdAt: toIso(comment.createdAt),
      bodyPreview: sanitizeBody(comment.body)
    }));

    const uniqueAgentAuthors = new Set(
      entries.map((e) => e.authorAgentId).filter((id): id is string => id !== null)
    );
    const uniqueUserAuthors = new Set(
      entries.map((e) => e.authorUserId).filter((id): id is string => id !== null)
    );

    const summaryLines = [
      `Issue ${issue.id} ("${issue.title}") — ${entries.length} comment interaction(s)` +
        (validated.from || validated.to
          ? ` in window [${validated.from ?? "-inf"}, ${validated.to ?? "+inf"})`
          : ""),
      `Distinct agent authors: ${uniqueAgentAuthors.size}, distinct user authors: ${uniqueUserAuthors.size}`
    ];

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Summarized ${entries.length} interaction(s) for issue ${validated.issueId}`,
      entityType: "issue",
      entityId: validated.issueId,
      metadata: {
        issueId: validated.issueId,
        from: validated.from ?? null,
        to: validated.to ?? null,
        interactionCount: entries.length,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`Summarized ${entries.length} interaction(s) for Paperclip issue ${validated.issueId}`);

    return {
      content: summaryLines.join("\n"),
      data: {
        issueId: issue.id,
        title: issue.title,
        status: issue.status,
        from: validated.from ?? null,
        to: validated.to ?? null,
        interactionCount: entries.length,
        distinctAgentAuthors: uniqueAgentAuthors.size,
        distinctUserAuthors: uniqueUserAuthors.size,
        interactions: entries
      }
    };
  }
};
