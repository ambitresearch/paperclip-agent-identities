/**
 * github_bot_create_pull_request — Creates a GitHub pull request using the
 * configured bot identity. Enforces repository owner policy before resolving
 * any secrets.
 */
import type { PluginContext, ToolRunContext, ToolResult } from "@paperclipai/plugin-sdk";
import { evaluateRepoPolicy, resolveAgentIdentityFromToolRunContext } from "../identity-policy.js";
import { resolveIdentityToken } from "../credential-sidecar.js";
import { githubBotCreatePullRequestToolMetadata, githubBotCreatePullRequestToolName } from "../shared/github-bot-create-pull-request-tool.js";

export interface CreatePullRequestParams {
  repository: string;
  head: string;
  base: string;
  title: string;
  body?: string;
  draft?: boolean;
  paperclipIssueId?: string;
}

function validateParams(params: unknown): CreatePullRequestParams | string {
  if (!params || typeof params !== "object") {
    return "params must be a non-null object";
  }
  const p = params as Record<string, unknown>;

  if (!p.repository || typeof p.repository !== "string") {
    return "repository is required (e.g. \"roshangautam/my-repo\")";
  }
  if (!p.head || typeof p.head !== "string") {
    return "head branch is required";
  }
  if (!p.base || typeof p.base !== "string") {
    return "base branch is required";
  }
  if (!p.title || typeof p.title !== "string") {
    return "title is required";
  }
  if (p.body !== undefined && typeof p.body !== "string") {
    return "body must be a string if provided";
  }
  if (p.draft !== undefined && typeof p.draft !== "boolean") {
    return "draft must be a boolean if provided";
  }
  if (p.paperclipIssueId !== undefined && typeof p.paperclipIssueId !== "string") {
    return "paperclipIssueId must be a string if provided";
  }

  return {
    repository: p.repository,
    head: p.head,
    base: p.base,
    title: p.title,
    body: p.body as string | undefined,
    draft: p.draft as boolean | undefined,
    paperclipIssueId: p.paperclipIssueId as string | undefined,
  };
}

export function registerCreatePullRequestTool(ctx: PluginContext): void {
  ctx.tools.register(
    githubBotCreatePullRequestToolName,
    githubBotCreatePullRequestToolMetadata,
    async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
      const validated = validateParams(params);
      if (typeof validated === "string") {
        return { error: validated };
      }

      let resolvedIdentity: ReturnType<typeof resolveAgentIdentityFromToolRunContext>;
      try {
        resolvedIdentity = resolveAgentIdentityFromToolRunContext(await ctx.config.get(), runCtx);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { error: reason };
      }

      // Enforce repo policy BEFORE resolving any secrets.
      const policyDecision = evaluateRepoPolicy(resolvedIdentity.identity, validated.repository);
      if (!policyDecision.allowed) {
        return { error: policyDecision.reason };
      }

      // Resolve token just-in-time.
      let token: string;
      try {
        ({ token } = await resolveIdentityToken(resolvedIdentity, ctx.secrets.resolve.bind(ctx.secrets)));
      } catch (err) {
        ctx.logger.error("Failed to resolve bot token", {
          agentId: runCtx.agentId,
          repository: validated.repository,
          reason: err instanceof Error ? err.message : String(err),
        });
        return { error: "Failed to resolve bot authentication credentials" };
      }

      // Call GitHub REST API — use the canonical owner/repo from the policy
      // decision (which normalizes URLs, SSH remotes, etc.) instead of naively
      // splitting the raw input.
      const { owner, repo } = policyDecision.repo!;
      const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls`;

      let response: Response;
      try {
        response = await ctx.http.fetch(apiUrl, {
          method: "POST",
          headers: {
            "Accept": "application/vnd.github+json",
            "Authorization": `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: validated.title,
            body: validated.body ?? "",
            head: validated.head,
            base: validated.base,
            draft: validated.draft ?? false,
          }),
        });
      } catch (err) {
        ctx.logger.error("GitHub API request failed", {
          agentId: runCtx.agentId,
          repository: validated.repository,
          reason: err instanceof Error ? err.message : String(err),
        });
        return { error: "GitHub API request failed. Check network connectivity." };
      }

      if (!response.ok) {
        let errorDetail: string;
        try {
          const errBody = await response.json() as { message?: string; errors?: Array<{ message?: string }> };
          const messages = errBody.errors?.map((e) => e.message).filter(Boolean) ?? [];
          errorDetail = errBody.message
            ? `${errBody.message}${messages.length ? `: ${messages.join("; ")}` : ""}`
            : `HTTP ${response.status}`;
        } catch {
          errorDetail = `HTTP ${response.status}`;
        }
        ctx.logger.warn("GitHub PR creation failed", {
          agentId: runCtx.agentId,
          repository: validated.repository,
          status: response.status,
        });
        return { error: `GitHub API error: ${errorDetail}` };
      }

      const prData = await response.json() as {
        number: number;
        html_url: string;
        state: string;
        draft: boolean;
        head: { ref: string };
        base: { ref: string };
      };

      // Log the action through activity
      await ctx.activity.log({
        companyId: runCtx.companyId,
        message: `Created PR #${prData.number} in ${validated.repository}`,
        entityType: "pull_request",
        entityId: String(prData.number),
        metadata: {
          repository: validated.repository,
          prNumber: prData.number,
          prUrl: prData.html_url,
          head: prData.head.ref,
          base: prData.base.ref,
          draft: prData.draft,
          agentId: runCtx.agentId,
          ...(validated.paperclipIssueId ? { paperclipIssueId: validated.paperclipIssueId } : {}),
        },
      });

      ctx.logger.info("Pull request created successfully", {
        agentId: runCtx.agentId,
        repository: validated.repository,
        prNumber: prData.number,
      });

      return {
        content: `Created PR #${prData.number}: ${prData.html_url}`,
        data: {
          number: prData.number,
          url: prData.html_url,
          state: prData.state,
          draft: prData.draft,
          head: prData.head.ref,
          base: prData.base.ref,
        },
      };
    },
  );
}
