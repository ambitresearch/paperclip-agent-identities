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
import {
  githubBotGetIssueToolMetadata,
  githubBotGetIssueToolName
} from "../../../shared/github-bot-get-issue-tool.js";

export interface GetIssueParams {
  repository: string;
  issueNumber: number;
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
  const validated: GetIssueParams = {
    repository: p.repository,
    issueNumber: p.issueNumber
  };
  return { ok: true, params: validated };
}

export const githubGetIssueToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotGetIssueToolName,
  metadata: githubBotGetIssueToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as GetIssueParams;
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
    const validated = execution.params as GetIssueParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/issues/${validated.issueNumber}`;

    let response: Response;
    try {
      response = await ctx.http.fetch(apiUrl, {
        method: "GET",
        headers: {
          "Accept": "application/vnd.github+json",
          "Authorization": `Bearer ${token}`,
          "User-Agent": "paperclip-agent-identities/github-api",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_get_issue network failure: ${reason}`);
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
        error: `GitHub API returned ${response.status} fetching the issue. ${details}`.trim()
      };
    }

    // Note: full linked-PR detection requires walking the issue timeline
    // events endpoint (a second REST call) to find "cross-referenced" /
    // "connected" events. That is out of scope here — this returns the
    // core issue fields only. A follow-up tool can add timeline-derived
    // linked-PR info if needed.
    const issue = (await response.json()) as {
      number: number;
      title: string;
      body: string | null;
      state: string;
      html_url: string;
      assignees: Array<{ login: string }>;
      labels: Array<{ name: string } | string>;
      milestone: { number: number; title: string } | null;
    };

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Fetched issue #${validated.issueNumber} in ${repository.fullName}`,
      entityType: "issue",
      entityId: String(issue.number),
      metadata: {
        repository: repository.fullName,
        issueNumber: validated.issueNumber,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`Fetched issue #${validated.issueNumber} in ${repository.fullName}`);

    return {
      content: `Issue #${issue.number}: ${issue.title} (${issue.state})`,
      data: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        url: issue.html_url,
        assignees: issue.assignees.map((a) => a.login),
        labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
        milestone: issue.milestone ? { number: issue.milestone.number, title: issue.milestone.title } : null
      }
    };
  }
};
