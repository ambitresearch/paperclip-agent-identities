import { describe, it, expect } from "vitest";
import { githubManifestTools } from "../../../src/providers/github/manifest-tools.js";
import { githubBotWhoamiToolName } from "../../../src/shared/github-bot-whoami-tool.js";
import { githubBotCreatePullRequestToolName } from "../../../src/shared/github-bot-create-pull-request-tool.js";
import { GITHUB_BOT_PUSH_BRANCH_TOOL_NAME } from "../../../src/shared/github-bot-push-branch-tool-definition.js";
import { githubBotSubmitPullRequestReviewToolName } from "../../../src/shared/github-bot-submit-pull-request-review-tool.js";
import { githubBotGetPullRequestChecksToolName } from "../../../src/shared/github-bot-get-pull-request-checks-tool.js";
import { githubBotRequestPullRequestReviewersToolName } from "../../../src/shared/github-bot-request-pull-request-reviewers-tool.js";

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

  it("each fragment carries manifest metadata (displayName + parametersSchema)", () => {
    for (const tool of githubManifestTools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.displayName).toBe("string");
      expect(typeof tool.parametersSchema).toBe("object");
    }
  });
});
