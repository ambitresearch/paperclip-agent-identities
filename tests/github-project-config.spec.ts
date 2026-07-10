import { describe, expect, it } from "vitest";
import { projectGitHubPluginConfig } from "../src/providers/github/config.js";
import type { AgentIdentityConfig } from "../src/core/identity-config.js";

function ghConfig(agentId: string, over: Partial<{ commitName: string; commitEmail: string }> = {}): AgentIdentityConfig {
  return {
    provider: "github",
    id: `github:${agentId}`,
    agentId,
    label: `Bot ${agentId}`,
    github: {
      username: `${agentId}-bot`,
      ...(over.commitName ? { commitName: over.commitName } : {}),
      ...(over.commitEmail ? { commitEmail: over.commitEmail } : {}),
    },
  };
}

describe("projectGitHubPluginConfig", () => {
  it("projects a v4 github identity into the flat plugin-config shape keyed by agentId", () => {
    const projected = projectGitHubPluginConfig({ gh: ghConfig("gh") });
    expect(projected).toEqual({
      gh: { label: "Bot gh", githubUsername: "gh-bot" },
    });
  });

  it("includes commitName/commitEmail when present and omits them when absent", () => {
    const withCommit = projectGitHubPluginConfig({
      gh: ghConfig("gh", { commitName: "Bot Author", commitEmail: "bot@example.com" }),
    });
    expect(withCommit.gh).toEqual({
      label: "Bot gh",
      githubUsername: "gh-bot",
      commitName: "Bot Author",
      commitEmail: "bot@example.com",
    });

    const withoutCommit = projectGitHubPluginConfig({ gh: ghConfig("gh") });
    expect(withoutCommit.gh).not.toHaveProperty("commitName");
    expect(withoutCommit.gh).not.toHaveProperty("commitEmail");
  });

  it("polymorphically filters out non-github identities (the Replace-Conditional target)", () => {
    const exampleEntry = {
      provider: "example",
      id: "example:ex",
      agentId: "ex",
      label: "Example",
      example: { handle: "ex-handle" },
    };
    const projected = projectGitHubPluginConfig({
      gh: ghConfig("gh"),
      ex: exampleEntry as unknown as AgentIdentityConfig,
    });
    expect(Object.keys(projected)).toEqual(["gh"]);
  });

  it("returns an empty object for empty input", () => {
    expect(projectGitHubPluginConfig({})).toEqual({});
  });
});
