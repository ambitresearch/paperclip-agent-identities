import { githubBotWhoamiManifestTool } from "../../shared/github-bot-whoami-tool.js";
import { githubBotCreatePullRequestManifestTool } from "../../shared/github-bot-create-pull-request-tool.js";
import { githubBotPushBranchManifestTool } from "../../shared/github-bot-push-branch-tool-definition.js";
import { githubBotSubmitPullRequestReviewManifestTool } from "../../shared/github-bot-submit-pull-request-review-tool.js";
import { githubBotAddIssueCommentManifestTool } from "../../shared/github-bot-add-issue-comment-tool.js";
import { githubBotListIssueCommentsManifestTool } from "../../shared/github-bot-list-issue-comments-tool.js";
import { githubBotGetIssueManifestTool } from "../../shared/github-bot-get-issue-tool.js";
import { githubBotUpdateIssueManifestTool } from "../../shared/github-bot-update-issue-tool.js";
import { githubBotGetPullRequestManifestTool } from "../../shared/github-bot-get-pull-request-tool.js";
import { githubBotListPullRequestFilesManifestTool } from "../../shared/github-bot-list-pull-request-files-tool.js";
import { githubBotListOrganizationProjectsManifestTool } from "../../shared/github-bot-list-organization-projects-tool.js";
import { githubBotAddPullRequestToProjectManifestTool } from "../../shared/github-bot-add-pull-request-to-project-tool.js";
import { githubBotAssignToCurrentUserManifestTool } from "../../shared/github-bot-assign-to-current-user-tool.js";
import { githubBotUpdatePullRequestManifestTool } from "../../shared/github-bot-update-pull-request-tool.js";
import { githubBotGetPullRequestChecksManifestTool } from "../../shared/github-bot-get-pull-request-checks-tool.js";
import { githubBotRequestPullRequestReviewersManifestTool } from "../../shared/github-bot-request-pull-request-reviewers-tool.js";
import { githubBotReplyToReviewThreadManifestTool } from "../../shared/github-bot-reply-to-review-thread-tool.js";
import { githubBotResolveReviewThreadManifestTool } from "../../shared/github-bot-resolve-review-thread-tool.js";
import { githubBotUnresolveReviewThreadManifestTool } from "../../shared/github-bot-unresolve-review-thread-tool.js";
import { githubBotListPullRequestReviewThreadsManifestTool } from "../../shared/github-bot-list-pull-request-review-threads-tool.js";

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
  githubBotAddIssueCommentManifestTool,
  githubBotListIssueCommentsManifestTool,
  githubBotGetIssueManifestTool,
  githubBotUpdateIssueManifestTool,
  githubBotGetPullRequestManifestTool,
  githubBotListPullRequestFilesManifestTool,
  githubBotListOrganizationProjectsManifestTool,
  githubBotAddPullRequestToProjectManifestTool,
  githubBotAssignToCurrentUserManifestTool,
  githubBotUpdatePullRequestManifestTool,
  githubBotGetPullRequestChecksManifestTool,
  githubBotRequestPullRequestReviewersManifestTool,
  githubBotReplyToReviewThreadManifestTool,
  githubBotResolveReviewThreadManifestTool,
  githubBotUnresolveReviewThreadManifestTool,
  githubBotListPullRequestReviewThreadsManifestTool,
] as const;
