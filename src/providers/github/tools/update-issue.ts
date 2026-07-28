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
  githubBotUpdateIssueToolMetadata,
  githubBotUpdateIssueToolName
} from "../../../shared/github-bot-update-issue-tool.js";

const VALID_STATES = ["open", "closed"] as const;
type IssueState = (typeof VALID_STATES)[number];

export interface UpdateIssueParams {
  repository: string;
  issueNumber: number;
  title?: string;
  body?: string;
  state?: IssueState;
  stateReason?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number | null;
  llmModel?: string;
  paperclipIssueId?: string;
}

function validateStringArray(raw: unknown, field: string): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === "string")) {
    return { ok: false, error: `${field} must be an array of strings if provided` };
  }
  return { ok: true, value: raw };
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
  if (p.title !== undefined && typeof p.title !== "string") {
    return { ok: false, error: "title must be a string if provided" };
  }
  if (p.body !== undefined && typeof p.body !== "string") {
    return { ok: false, error: "body must be a string if provided" };
  }
  if (p.state !== undefined && !VALID_STATES.includes(p.state as IssueState)) {
    return { ok: false, error: 'state must be one of "open", "closed" if provided' };
  }
  if (p.stateReason !== undefined && typeof p.stateReason !== "string") {
    return { ok: false, error: "stateReason must be a string if provided" };
  }
  let labels: string[] | undefined;
  if (p.labels !== undefined) {
    const result = validateStringArray(p.labels, "labels");
    if (!result.ok) return result;
    labels = result.value;
  }
  let assignees: string[] | undefined;
  if (p.assignees !== undefined) {
    const result = validateStringArray(p.assignees, "assignees");
    if (!result.ok) return result;
    assignees = result.value;
  }
  if (p.milestone !== undefined && p.milestone !== null && (typeof p.milestone !== "number" || !Number.isInteger(p.milestone))) {
    return { ok: false, error: "milestone must be an integer or null if provided" };
  }
  if (p.llmModel !== undefined && typeof p.llmModel !== "string") {
    return { ok: false, error: "llmModel must be a string if provided" };
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return { ok: false, error: "paperclipIssueId must be a string if provided" };
  }

  const hasAnyUpdate =
    p.title !== undefined ||
    p.body !== undefined ||
    p.state !== undefined ||
    p.stateReason !== undefined ||
    labels !== undefined ||
    assignees !== undefined ||
    p.milestone !== undefined;
  if (!hasAnyUpdate) {
    return { ok: false, error: "At least one updatable field (title, body, state, stateReason, labels, assignees, milestone) is required" };
  }

  const validated: UpdateIssueParams = {
    repository: p.repository,
    issueNumber: p.issueNumber,
    title: p.title as string | undefined,
    body: p.body as string | undefined,
    state: p.state as IssueState | undefined,
    stateReason: p.stateReason as string | undefined,
    labels,
    assignees,
    milestone: p.milestone as number | null | undefined,
    llmModel: p.llmModel as string | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined
  };
  return { ok: true, params: validated };
}

export const githubUpdateIssueToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotUpdateIssueToolName,
  metadata: githubBotUpdateIssueToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as UpdateIssueParams;
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
    const validated = execution.params as UpdateIssueParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${validated.issueNumber}`;

    const requestBody: Record<string, unknown> = {};
    if (validated.title !== undefined) requestBody.title = validated.title;
    if (validated.body !== undefined && validated.body.trim()) {
      requestBody.body = appendAiAuthorshipFooter(validated.body, validated.llmModel);
    } else if (validated.body !== undefined) {
      requestBody.body = validated.body;
    }
    if (validated.state !== undefined) requestBody.state = validated.state;
    if (validated.stateReason !== undefined) requestBody.state_reason = validated.stateReason;
    if (validated.labels !== undefined) requestBody.labels = validated.labels;
    if (validated.assignees !== undefined) requestBody.assignees = validated.assignees;
    if (validated.milestone !== undefined) requestBody.milestone = validated.milestone;

    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
        method: "PATCH",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "paperclip-agent-identities/github-api",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_update_issue network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} updating the issue. ${details}`.trim()
      };
    }

    const updated = (await response.json()) as {
      number: number;
      title: string;
      state: string;
      html_url: string;
    };

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Updated issue #${validated.issueNumber} in ${repository.fullName}`,
      entityType: "issue",
      entityId: String(updated.number),
      metadata: {
        repository: repository.fullName,
        issueNumber: validated.issueNumber,
        agentId: runCtx.agentId,
        ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {})
      }
    });
    ctx.logger.info(`Updated issue #${updated.number} in ${repository.fullName}`);

    return {
      content: `Updated issue #${updated.number}: ${updated.html_url}`,
      data: {
        number: updated.number,
        title: updated.title,
        state: updated.state,
        url: updated.html_url
      }
    };
  }
};
