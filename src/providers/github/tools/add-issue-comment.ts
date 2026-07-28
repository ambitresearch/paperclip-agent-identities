import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import type { GitHubRepoRef } from "../repo-ref.js";
import { normalizeGitHubRepoRef } from "../repo-ref.js";
import { appendAiAuthorshipFooter } from "../../../shared/github-ai-authorship-footer.js";
import {
  githubBotAddIssueCommentToolMetadata,
  githubBotAddIssueCommentToolName
} from "../../../shared/github-bot-add-issue-comment-tool.js";

export interface AddIssueCommentParams {
  repository: string;
  issueNumber: number;
  body: string;
  llmModel?: string;
  paperclipIssueId?: string;
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.repository || typeof p.repository !== "string") {
    return { ok: false, error: 'repository is required (e.g. "my-org/my-repo")' };
  }
  if (typeof p.issueNumber !== "number" || !Number.isInteger(p.issueNumber) || p.issueNumber <= 0) {
    return { ok: false, error: "issueNumber must be a positive integer" };
  }
  if (!p.body || typeof p.body !== "string" || !p.body.trim()) {
    return { ok: false, error: "body is required" };
  }
  if (p.llmModel !== undefined && typeof p.llmModel !== "string") {
    return { ok: false, error: "llmModel must be a string if provided" };
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }
  const validated: AddIssueCommentParams = {
    repository: p.repository,
    issueNumber: p.issueNumber,
    body: p.body,
    llmModel: p.llmModel as string | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

export const githubAddIssueCommentToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotAddIssueCommentToolName,
  metadata: githubBotAddIssueCommentToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as AddIssueCommentParams;
    const ref = normalizeGitHubRepoRef(params.repository);
    if (!ref) {
      return { ok: false, error: "Invalid repository format" };
    }
    return { ok: true, ref };
  },
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef>
  ): Promise<unknown> {
    if (execution.token === null) {
      return { error: "Internal error: missing resolved credential." };
    }
    const token = execution.token;
    const ctx = execution.ctx;
    const runCtx = execution.runCtx;
    const validated = execution.params as AddIssueCommentParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${validated.issueNumber}/comments`;

    const bodyWithFooter = appendAiAuthorshipFooter(validated.body, validated.llmModel);

    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
        method: "POST",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "paperclip-agent-identities/github-api",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ body: bodyWithFooter })
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_add_issue_comment network failure: ${reason}`);
      return { error: "GitHub API request failed before a response was received." };
    }

    if (!response.ok) {
      let details = "";
      try {
        const errBody = (await response.json()) as { message?: string; errors?: unknown };
        const parts: string[] = [];
        if (errBody.message) parts.push(errBody.message);
        if (errBody.errors) parts.push(JSON.stringify(errBody.errors));
        details = parts.join(" ");
      } catch {
        details = await response.text().catch(() => "");
      }
      return {
        error: `GitHub API returned ${response.status} adding the issue comment. ${details}`.trim()
      };
    }

    const created = (await response.json()) as {
      id: number;
      html_url: string;
      body: string;
    };

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Added comment on issue #${validated.issueNumber} in ${repository.fullName}`,
      entityType: "issue_comment",
      entityId: String(created.id),
      metadata: {
        repository: repository.fullName,
        issueNumber: validated.issueNumber,
        commentId: created.id,
        commentUrl: created.html_url,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(`Added comment #${created.id} on issue #${validated.issueNumber} in ${repository.fullName}`);

    return {
      content: `Added comment on issue #${validated.issueNumber}: ${created.html_url}`,
      data: {
        id: created.id,
        url: created.html_url
      }
    };
  }
};
