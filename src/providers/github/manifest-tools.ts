import { githubBotWhoamiManifestTool } from "../../shared/github-bot-whoami-tool.js";
import { githubBotCreatePullRequestManifestTool } from "../../shared/github-bot-create-pull-request-tool.js";
import { githubBotPushBranchManifestTool } from "../../shared/github-bot-push-branch-tool-definition.js";
import { githubBotSubmitPullRequestReviewManifestTool } from "../../shared/github-bot-submit-pull-request-review-tool.js";

/**
 * The manifest-tool fragments the GitHub provider contributes to the plugin
 * manifest. `manifest.ts` (Task 15) flat-maps this across enabled providers;
 * the GitHub `IdentityProvider` (Task 12) exposes it as `manifestTools`.
 */
export const githubManifestTools = [
  githubBotWhoamiManifestTool,
  githubBotCreatePullRequestManifestTool,
  githubBotPushBranchManifestTool,
  githubBotSubmitPullRequestReviewManifestTool,
] as const;
