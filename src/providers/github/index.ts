import type {
  IdentityProvider,
  IdentityProviderDefinition
} from "../../core/provider-contract.js";
import type { ResourceReference } from "../../core/resource-reference.js";
import {
  githubIdentitySchema,
  projectGitHubPluginConfig,
  type GitHubAgentIdentity
} from "./config.js";
import { resolveGitHubCredential } from "./credentials.js";
import { githubWhoamiToolSpec } from "./tools/whoami.js";
import { githubCreatePullRequestToolSpec } from "./tools/create-pull-request.js";
import { githubPushBranchToolSpec } from "./tools/push-branch.js";
import { githubSubmitPullRequestReviewToolSpec } from "./tools/submit-pull-request-review.js";
import { githubGetPullRequestChecksToolSpec } from "./tools/get-pull-request-checks.js";
import { githubRequestPullRequestReviewersToolSpec } from "./tools/request-pull-request-reviewers.js";
import { githubAddIssueCommentToolSpec } from "./tools/add-issue-comment.js";
import { githubListIssueCommentsToolSpec } from "./tools/list-issue-comments.js";
import { githubGetIssueToolSpec } from "./tools/get-issue.js";
import { githubUpdateIssueToolSpec } from "./tools/update-issue.js";
import { githubGetPullRequestToolSpec } from "./tools/get-pull-request.js";
import { githubListPullRequestFilesToolSpec } from "./tools/list-pull-request-files.js";
import { githubListOrganizationProjectsToolSpec } from "./tools/list-organization-projects.js";
import { githubAddPullRequestToProjectToolSpec } from "./tools/add-pull-request-to-project.js";
import { githubAssignToCurrentUserToolSpec } from "./tools/assign-to-current-user.js";
import { githubUpdatePullRequestToolSpec } from "./tools/update-pull-request.js";
import { githubReplyToReviewThreadToolSpec } from "./tools/reply-to-review-thread.js";
import { githubResolveReviewThreadToolSpec } from "./tools/resolve-review-thread.js";
import { githubUnresolveReviewThreadToolSpec } from "./tools/unresolve-review-thread.js";
import { githubListPullRequestReviewThreadsToolSpec } from "./tools/list-pull-request-review-threads.js";
import { githubSearchRepositoryItemsToolSpec } from "./tools/search-repository-items.js";
import { githubUploadPullRequestAssetToolSpec } from "./tools/upload-pull-request-asset.js";
import { githubGetIssueInteractionSummaryToolSpec } from "./tools/get-issue-interaction-summary.js";
import { githubLinkGithubItemToolSpec } from "./tools/link-github-item.js";
import { githubManifestTools } from "./manifest-tools.js";
import { contributeGitHubAppManifestActions } from "./app-manifest.js";

/**
 * Provider id literal. Intentionally a module-local constant rather than an
 * import from `src/shared/types.ts` — the adapter must not depend on the
 * shared provider enum, so a new provider can be added without touching shared
 * types or the worker loop.
 */
export const GITHUB_PROVIDER_ID = "github";

const githubProviderDefinition: IdentityProviderDefinition = {
  id: GITHUB_PROVIDER_ID,
  name: "GitHub",
  status: "enabled",
  description:
    "GitHub App identity for repositories, pull requests, branch pushes, and commit attribution."
};

/**
 * Validate a single agent identity against the exported GitHub identity schema.
 * Reuses `githubIdentitySchema` (Task 6) so the identity shape has one source
 * of truth (DRY). Returns the parsed identity on success, or a joined error
 * string on failure — matching the `IdentityProvider.validateConfig` contract.
 */
export function validateGitHubConfig(raw: unknown): GitHubAgentIdentity | string {
  const parsed = githubIdentitySchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => issue.message).join("; ");
  }
  return parsed.data;
}

export const githubProvider: IdentityProvider<GitHubAgentIdentity, ResourceReference> = {
  id: GITHUB_PROVIDER_ID,
  definition: githubProviderDefinition,
  validateConfig: validateGitHubConfig,
  projectPluginConfig: projectGitHubPluginConfig,
  resolveCredential: resolveGitHubCredential,
  // The sixteen tool specs have heterogeneous TRefs (whoami=ResourceReference,
  // most others=GitHubRepoRef or a repo-scoped variant). They are all
  // assignable to ProviderToolSpec<GitHubAgentIdentity, ResourceReference>
  // because ProviderToolSpec declares perform/resolveResourceRef/validateParams
  // as METHODS — method parameters are bivariant even under strictFunctionTypes.
  // Do NOT "fix" this into a union TRef; that would break the uniform tool
  // typing the registry (Task 14) and pipeline (Task 3) rely on, and is
  // unnecessary.
  tools: [
    githubWhoamiToolSpec,
    githubCreatePullRequestToolSpec,
    githubPushBranchToolSpec,
    githubSubmitPullRequestReviewToolSpec,
    githubAddIssueCommentToolSpec,
    githubListIssueCommentsToolSpec,
    githubGetIssueToolSpec,
    githubUpdateIssueToolSpec,
    githubGetPullRequestToolSpec,
    githubListPullRequestFilesToolSpec,
    githubListOrganizationProjectsToolSpec,
    githubAddPullRequestToProjectToolSpec,
    githubAssignToCurrentUserToolSpec,
    githubUpdatePullRequestToolSpec,
    githubGetPullRequestChecksToolSpec,
    githubRequestPullRequestReviewersToolSpec,
    githubReplyToReviewThreadToolSpec,
    githubResolveReviewThreadToolSpec,
    githubUnresolveReviewThreadToolSpec,
    githubListPullRequestReviewThreadsToolSpec,
    githubSearchRepositoryItemsToolSpec,
    githubUploadPullRequestAssetToolSpec,
    githubGetIssueInteractionSummaryToolSpec,
    githubLinkGithubItemToolSpec
  ],
  contributeActions: contributeGitHubAppManifestActions,
  manifestTools: githubManifestTools
};
