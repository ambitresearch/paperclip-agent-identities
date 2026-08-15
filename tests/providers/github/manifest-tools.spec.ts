import { describe, it, expect } from "vitest";
import { githubManifestTools } from "../../../src/providers/github/manifest-tools.js";
import { githubBotWhoamiToolName } from "../../../src/shared/github-bot-whoami-tool.js";
import { githubBotCreatePullRequestToolName } from "../../../src/shared/github-bot-create-pull-request-tool.js";
import { GITHUB_BOT_PUSH_BRANCH_TOOL_NAME } from "../../../src/shared/github-bot-push-branch-tool-definition.js";
import { githubBotSubmitPullRequestReviewToolName } from "../../../src/shared/github-bot-submit-pull-request-review-tool.js";
import { githubBotMergePullRequestToolName } from "../../../src/shared/github-bot-merge-pull-request-tool.js";
import { githubBotGetPullRequestChecksToolName } from "../../../src/shared/github-bot-get-pull-request-checks-tool.js";
import { githubBotRequestPullRequestReviewersToolName } from "../../../src/shared/github-bot-request-pull-request-reviewers-tool.js";
import { githubBotAddIssueCommentToolName } from "../../../src/shared/github-bot-add-issue-comment-tool.js";
import { githubBotListIssueCommentsToolName } from "../../../src/shared/github-bot-list-issue-comments-tool.js";
import { githubBotGetIssueToolName } from "../../../src/shared/github-bot-get-issue-tool.js";
import { githubBotUpdateIssueToolName } from "../../../src/shared/github-bot-update-issue-tool.js";
import { githubBotGetPullRequestToolName } from "../../../src/shared/github-bot-get-pull-request-tool.js";
import { githubBotListPullRequestFilesToolName } from "../../../src/shared/github-bot-list-pull-request-files-tool.js";
import { githubBotListOrganizationProjectsToolName } from "../../../src/shared/github-bot-list-organization-projects-tool.js";
import { githubBotAddPullRequestToProjectToolName } from "../../../src/shared/github-bot-add-pull-request-to-project-tool.js";
import { githubBotAssignToCurrentUserToolName } from "../../../src/shared/github-bot-assign-to-current-user-tool.js";
import { githubBotUpdatePullRequestToolName } from "../../../src/shared/github-bot-update-pull-request-tool.js";
import { githubBotReplyToReviewThreadToolName } from "../../../src/shared/github-bot-reply-to-review-thread-tool.js";
import { githubBotResolveReviewThreadToolName } from "../../../src/shared/github-bot-resolve-review-thread-tool.js";
import { githubBotUnresolveReviewThreadToolName } from "../../../src/shared/github-bot-unresolve-review-thread-tool.js";
import { githubBotListPullRequestReviewThreadsToolName } from "../../../src/shared/github-bot-list-pull-request-review-threads-tool.js";
import { githubBotSearchRepositoryItemsToolName } from "../../../src/shared/github-bot-search-repository-items-tool.js";
import { githubBotUploadPullRequestAssetToolName } from "../../../src/shared/github-bot-upload-pull-request-asset-tool.js";
import { githubBotGetIssueInteractionSummaryToolName } from "../../../src/shared/github-bot-get-issue-interaction-summary-tool.js";
import { githubBotLinkGithubItemToolName } from "../../../src/shared/github-bot-link-github-item-tool.js";

describe("githubManifestTools", () => {
  it("starts with github_bot_whoami and includes every registered fragment exactly once", () => {
    const names = githubManifestTools.map((tool) => tool.name);
    expect(names[0]).toBe(githubBotWhoamiToolName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        githubBotWhoamiToolName,
        githubBotCreatePullRequestToolName,
        GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
        githubBotSubmitPullRequestReviewToolName,
        githubBotGetPullRequestChecksToolName,
        githubBotRequestPullRequestReviewersToolName,
      ])
    );
  });

  it("exposes exactly the 25 required manifest tool fragments: the 21-action parity set plus the 4 non-overlapping identity tools", () => {
    const names = githubManifestTools.map((tool) => tool.name);
    const REQUIRED_TOOL_SET = new Set([
      // Plugin-specific identity tools (not in the Github Sync reference app).
      githubBotWhoamiToolName,
      GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
      githubBotSubmitPullRequestReviewToolName,
      githubBotMergePullRequestToolName,
      // 21-action Github Sync parity set.
      githubBotAddIssueCommentToolName,
      githubBotReplyToReviewThreadToolName,
      githubBotGetIssueInteractionSummaryToolName,
      githubBotUnresolveReviewThreadToolName,
      githubBotListOrganizationProjectsToolName,
      githubBotAddPullRequestToProjectToolName,
      githubBotUploadPullRequestAssetToolName,
      githubBotGetPullRequestChecksToolName,
      githubBotListIssueCommentsToolName,
      githubBotRequestPullRequestReviewersToolName,
      githubBotGetIssueToolName,
      githubBotAssignToCurrentUserToolName,
      githubBotLinkGithubItemToolName,
      githubBotSearchRepositoryItemsToolName,
      githubBotGetPullRequestToolName,
      githubBotListPullRequestFilesToolName,
      githubBotListPullRequestReviewThreadsToolName,
      githubBotResolveReviewThreadToolName,
      githubBotUpdateIssueToolName,
      githubBotCreatePullRequestToolName,
      githubBotUpdatePullRequestToolName,
    ]);
    expect(REQUIRED_TOOL_SET.size).toBe(25);
    expect(new Set(names)).toEqual(REQUIRED_TOOL_SET);
    expect(names.length).toBe(25);
  });

  it("each fragment carries manifest metadata (displayName + parametersSchema)", () => {
    for (const tool of githubManifestTools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.displayName).toBe("string");
      expect(typeof tool.parametersSchema).toBe("object");
    }
  });
});
