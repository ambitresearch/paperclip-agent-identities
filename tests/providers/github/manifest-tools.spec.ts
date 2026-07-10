import { describe, it, expect } from "vitest";
import { githubManifestTools } from "../../../src/providers/github/manifest-tools.js";
import { githubBotWhoamiToolName } from "../../../src/shared/github-bot-whoami-tool.js";
import { githubBotCreatePullRequestToolName } from "../../../src/shared/github-bot-create-pull-request-tool.js";
import { GITHUB_BOT_PUSH_BRANCH_TOOL_NAME } from "../../../src/shared/github-bot-push-branch-tool-definition.js";

describe("githubManifestTools", () => {
  it("lists the three GitHub manifest fragments in registration order", () => {
    expect(githubManifestTools.map((tool) => tool.name)).toEqual([
      githubBotWhoamiToolName,
      githubBotCreatePullRequestToolName,
      GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
    ]);
  });

  it("each fragment carries manifest metadata (displayName + parametersSchema)", () => {
    for (const tool of githubManifestTools) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.displayName).toBe("string");
      expect(typeof tool.parametersSchema).toBe("object");
    }
  });
});
