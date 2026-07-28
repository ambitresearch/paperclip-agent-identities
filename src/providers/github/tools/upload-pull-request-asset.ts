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

// Only allow a single, safe filename segment: no path separators, no
// traversal, no NUL/control characters. This is enforced up front so
// `fileName` can never be used to escape the per-PR directory (e.g.
// "../pr-43/report.log") once it is embedded into the Contents API
// path and URL.
const SAFE_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeFileName(fileName: string): boolean {
  if (!SAFE_FILE_NAME_RE.test(fileName)) return false;
  if (fileName === "." || fileName === "..") return false;
  if (fileName.includes("..")) return false;
  return true;
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
  if (!isSafeFileName(p.fileName)) {
    return {
      ok: false,
      error:
        "fileName must be a single safe path segment (letters, digits, '.', '_', '-' only; " +
        "no path separators or '..')"
    };
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

    // The Contents API can only write to a branch (ref) that already
    // exists — it does not create one. Ensure the artifact branch exists
    // via the Git refs API (creating it from the repo's default branch
    // HEAD) before attempting any Contents write, so the first upload for
    // a given PR doesn't fail with a 404/422 from GitHub.
    const refUrl = `https://api.github.com/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`;
    let branchExists = false;
    try {
      const refResponse = await ctx.http.fetch(refUrl, { method: "GET", headers });
      if (refResponse.ok) {
        branchExists = true;
      } else if (refResponse.status !== 404) {
        return { error: `GitHub API returned ${refResponse.status} checking artifact branch '${branch}'.` };
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`github_bot_upload_pull_request_asset network failure checking branch: ${reason}`);
      return { error: "GitHub API request failed before a response was received." };
    }

    if (!branchExists) {
      let baseSha: string;
      try {
        const repoResponse = await ctx.http.fetch(`https://api.github.com/repos/${owner}/${repo}`, {
          method: "GET",
          headers
        });
        if (!repoResponse.ok) {
          return { error: `GitHub API returned ${repoResponse.status} resolving the default branch.` };
        }
        const repoInfo = (await repoResponse.json()) as { default_branch?: string };
        const defaultBranch = repoInfo.default_branch;
        if (!defaultBranch) {
          return { error: "Could not determine the repository's default branch." };
        }
        const defaultRefResponse = await ctx.http.fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/ref/${encodeURIComponent(`heads/${defaultBranch}`)}`,
          { method: "GET", headers }
        );
        if (!defaultRefResponse.ok) {
          return { error: `GitHub API returned ${defaultRefResponse.status} resolving the default branch SHA.` };
        }
        const defaultRef = (await defaultRefResponse.json()) as { object?: { sha?: string } };
        const sha = defaultRef.object?.sha;
        if (!sha) {
          return { error: "Could not determine the default branch's commit SHA." };
        }
        baseSha = sha;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown network error";
        ctx.logger.error(`github_bot_upload_pull_request_asset network failure resolving base: ${reason}`);
        return { error: "GitHub API request failed before a response was received." };
      }

      try {
        const createRefResponse = await ctx.http.fetch(
          `https://api.github.com/repos/${owner}/${repo}/git/refs`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha })
          }
        );
        if (!createRefResponse.ok) {
          // 422 "Reference already exists" means a concurrent call won the
          // race to create the branch; that's fine, proceed with the write.
          if (createRefResponse.status !== 422) {
            let details = "";
            try {
              const errBody = (await createRefResponse.json()) as { message?: string };
              details = errBody.message ?? "";
            } catch {
              details = await createRefResponse.text().catch(() => "");
            }
            return {
              error: `GitHub API returned ${createRefResponse.status} creating artifact branch '${branch}'. ${details}`.trim()
            };
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown network error";
        ctx.logger.error(`github_bot_upload_pull_request_asset network failure creating branch: ${reason}`);
        return { error: "GitHub API request failed before a response was received." };
      }
    }

    // Check if the file already exists on the artifact branch to get its
    // SHA for an update (otherwise the Contents API rejects an overwrite).
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
