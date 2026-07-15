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
  // The four tool specs have heterogeneous TRefs: whoami=ResourceReference,
  // create-PR=GitHubRepoRef, push-branch=GitHubPushTarget, submit-review=GitHubRepoRef.
  // They are all assignable to ProviderToolSpec<GitHubAgentIdentity, ResourceReference>
  // because ProviderToolSpec declares perform/resolveResourceRef/validateParams
  // as METHODS — method parameters are bivariant even under strictFunctionTypes.
  // Do NOT "fix" this into a union TRef (e.g. GitHubRepoRef | GitHubPushTarget);
  // that would break the uniform tool typing the registry (Task 14) and pipeline
  // (Task 3) rely on, and is unnecessary.
  tools: [
    githubWhoamiToolSpec,
    githubCreatePullRequestToolSpec,
    githubPushBranchToolSpec,
    githubSubmitPullRequestReviewToolSpec
  ],
  contributeActions: contributeGitHubAppManifestActions,
  manifestTools: githubManifestTools
};
