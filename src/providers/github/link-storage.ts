import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";

// Namespace + key for the plugin-state row that stores every GitHub link for
// a given Paperclip issue. Scoped to `scopeKind: "issue"` so storage lives
// independently of any project-repo mapping -- this is what makes linking
// work even when the target repository is not mapped to a Paperclip
// project. One state row per issue holds an array of link records; this
// keeps reads/writes to a single get+set round trip per call instead of one
// row per link. Shared between `github_bot_link_github_item` and the
// atomic linking step of `github_bot_create_pull_request`.
export const GITHUB_LINKS_NAMESPACE = "github-links";
export const GITHUB_LINKS_STATE_KEY = "links";
export const MAX_GITHUB_LINKS_PER_ISSUE = 200;

export interface GitHubItemLinkRecord {
  githubUrl: string;
  note: string | null;
  linkedByAgentId: string;
  linkedAt: string;
}

export interface PersistGithubLinkInput {
  ctx: Pick<PluginContext, "state" | "logger">;
  runCtx: Pick<ToolRunContext, "agentId">;
  paperclipIssueId: string;
  githubUrl: string;
  note?: string | null;
}

export interface PersistGithubLinkResult {
  ok: boolean;
  error?: string;
  record?: GitHubItemLinkRecord;
  totalLinks?: number;
}

function isLinkRecordArray(value: unknown): value is GitHubItemLinkRecord[] {
  return Array.isArray(value);
}

/**
 * Persists (or updates) a link between a Paperclip issue and a GitHub URL.
 * Used both by the standalone `github_bot_link_github_item` tool and by
 * `github_bot_create_pull_request`'s atomic "create then link" step, so the
 * two code paths cannot drift in storage shape or dedup behavior.
 */
export async function persistGithubLink(input: PersistGithubLinkInput): Promise<PersistGithubLinkResult> {
  const { ctx, runCtx, paperclipIssueId, githubUrl, note } = input;

  const scopeKey = {
    scopeKind: "issue" as const,
    scopeId: paperclipIssueId,
    namespace: GITHUB_LINKS_NAMESPACE,
    stateKey: GITHUB_LINKS_STATE_KEY
  };

  let existing: GitHubItemLinkRecord[] = [];
  try {
    const raw = await ctx.state.get(scopeKey);
    if (isLinkRecordArray(raw)) {
      existing = raw;
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown storage error";
    ctx.logger.error(`persistGithubLink failed to read existing links: ${reason}`);
    return { ok: false, error: "Failed to read existing GitHub links before linking." };
  }

  const now = new Date().toISOString();
  const record: GitHubItemLinkRecord = {
    githubUrl,
    note: note ?? null,
    linkedByAgentId: runCtx.agentId,
    linkedAt: now
  };

  const withoutDuplicate = existing.filter((link) => link.githubUrl !== githubUrl);
  const next = [...withoutDuplicate, record].slice(-MAX_GITHUB_LINKS_PER_ISSUE);

  try {
    await ctx.state.set(scopeKey, next);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown storage error";
    ctx.logger.error(`persistGithubLink failed to persist link: ${reason}`);
    return { ok: false, error: "Failed to persist the GitHub link." };
  }

  return { ok: true, record, totalLinks: next.length };
}
