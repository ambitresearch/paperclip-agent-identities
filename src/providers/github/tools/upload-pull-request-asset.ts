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
  githubBotUploadPullRequestAssetToolMetadata,
  githubBotUploadPullRequestAssetToolName
} from "../../../shared/github-bot-upload-pull-request-asset-tool.js";

export interface UploadPullRequestAssetParams {
  repository: string;
  pullNumber: number;
  fileName: string;
  contentBase64: string;
  mimeType?: string;
  commitMessage?: string;
}

const IMAGE_MIME_TYPES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif",
  "image/webp", "image/svg+xml", "image/bmp"
]);

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"
]);

function isImageFile(fileName: string, mimeType?: string): boolean {
  if (mimeType && IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) return true;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

function validateParams(params: unknown): ParamsValidation {
  if (!params || typeof params !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const p = params as Record<string, unknown>;
  if (!p.repository || typeof p.repository !== "string") {
    return { ok: false, error: 'repository is required (e.g. "my-org/my-repo")' };
  }
  if (typeof p.pullNumber !== "number" || !Number.isInteger(p.pullNumber) || p.pullNumber <= 0) {
    return { ok: false, error: "pullNumber must be a positive integer" };
  }
  if (!p.fileName || typeof p.fileName !== "string") {
    return { ok: false, error: "fileName is required" };
  }
  if (!p.contentBase64 || typeof p.contentBase64 !== "string") {
    return { ok: false, error: "contentBase64 is required" };
  }
  const validated: UploadPullRequestAssetParams = {
    repository: p.repository,
    pullNumber: p.pullNumber,
    fileName: p.fileName,
    contentBase64: p.contentBase64,
    mimeType: typeof p.mimeType === "string" ? p.mimeType : undefined,
    commitMessage: typeof p.commitMessage === "string" ? p.commitMessage : undefined
  };
  return { ok: true, params: validated };
}

export const githubUploadPullRequestAssetToolSpec: ProviderToolSpec<GitHubAgentIdentity, GitHubRepoRef> = {
  name: githubBotUploadPullRequestAssetToolName,
  metadata: githubBotUploadPullRequestAssetToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<GitHubAgentIdentity>
  ): Promise<ResourceRefResolution<GitHubRepoRef>> {
    const params = input.params as UploadPullRequestAssetParams;
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
    const validated = execution.params as UploadPullRequestAssetParams;
    const repository = execution.resourceRef as GitHubRepoRef;
    const { owner, repo } = repository;

    const branch = `artifacts/pr-${validated.pullNumber}`;
    const filePath = `pr-${validated.pullNumber}/${validated.fileName}`;
    const contentsUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

    const headers = {
      "Accept": "application/vnd.github+json",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "paperclip-agent-identities/github-api",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    };

    // Check if file already exists to get its SHA for an update
    let existingSha: string | undefined;
    try {
      const checkResponse = await ctx.http.fetch(`${contentsUrl}?ref=${branch}`, {
        method: "GET",
        headers
      });
      if (checkResponse.ok) {
        const existing = (await checkResponse.json()) as { sha?: string };
        existingSha = existing.sha;
      }
    } catch {
      // File doesn't exist yet — that's fine
    }

    const commitMessage =
      validated.commitMessage ??
      `Upload asset for PR #${validated.pullNumber}: ${validated.fileName}`;

    const body: Record<string, unknown> = {
      message: commitMessage,
      content: validated.contentBase64,
      branch
    };
    if (existingSha) {
      body.sha = existingSha;
    }

    let putResponse: Response;
    try {
      putResponse = await ctx.http.fetch(contentsUrl, {
        method: "PUT",
        headers,
        body: JSON.stringify(body)
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_upload_pull_request_asset network failure: ${reason}`);
      return { error: "GitHub API request failed before a response was received." };
    }

    if (!putResponse.ok) {
      let details = "";
      try {
        const errBody = (await putResponse.json()) as { message?: string; errors?: unknown };
        const parts: string[] = [];
        if (errBody.message) parts.push(errBody.message);
        if (errBody.errors) parts.push(JSON.stringify(errBody.errors));
        details = parts.join(" ");
      } catch {
        details = await putResponse.text().catch(() => "");
      }
      return {
        error: `GitHub API returned ${putResponse.status} uploading asset. ${details}`.trim()
      };
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
    const isImage = isImageFile(validated.fileName, validated.mimeType);
    const markdown = isImage
      ? `![${validated.fileName}](${rawUrl})`
      : `[${validated.fileName}](${rawUrl})`;

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Uploaded asset "${validated.fileName}" for PR #${validated.pullNumber} in ${repository.fullName}`,
      entityType: "pull_request",
      entityId: String(validated.pullNumber),
      metadata: {
        repository: repository.fullName,
        pullNumber: validated.pullNumber,
        fileName: validated.fileName,
        branch,
        rawUrl,
        agentId: runCtx.agentId
      }
    });
    ctx.logger.info(`Uploaded asset ${validated.fileName} to ${branch} in ${repository.fullName}`);

    return {
      content: `Asset uploaded successfully. Markdown reference: ${markdown}`,
      data: {
        rawUrl,
        branch,
        filePath,
        markdown
      }
    };
  }
};
