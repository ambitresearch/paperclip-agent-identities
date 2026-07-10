// Backward-compatibility re-exports. GitHub identity schema/config resolution
// has moved into src/providers/github/config.ts (see Task 6 of the provider
// adapter refactor). This shim keeps existing imports of these symbols from
// "./identity-policy.js" working; it is removed in a later task once every
// consumer imports directly from the provider package.
export {
  parseGitHubBotIdentityPluginConfig,
  resolveAgentIdentityFromToolRunContext
} from "./providers/github/config.js";
export type {
  GitHubAgentIdentity,
  GitHubBotIdentityPluginConfig,
  ResolvedAgentIdentity
} from "./providers/github/config.js";

export { normalizeGitHubRepoRef } from "./providers/github/repo-ref.js";
export type { GitHubRepoRef } from "./providers/github/repo-ref.js";
