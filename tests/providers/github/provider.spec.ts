import { describe, expect, it } from "vitest";

import { GITHUB_PROVIDER_ID, githubProvider } from "../../../src/providers/github/index.js";

describe("githubProvider", () => {
  it("exposes an enabled GitHub provider definition", () => {
    expect(GITHUB_PROVIDER_ID).toBe("github");
    expect(githubProvider.id).toBe("github");
    expect(githubProvider.definition.id).toBe("github");
    expect(githubProvider.definition.name).toBe("GitHub");
    expect(githubProvider.definition.status).toBe("enabled");
    expect(githubProvider.definition.description.length).toBeGreaterThan(0);
  });

  it("validateConfig returns the parsed identity for valid input", () => {
    const result = githubProvider.validateConfig({
      label: "Release Bot",
      githubUsername: "release-bot"
    });
    expect(result).toEqual({ label: "Release Bot", githubUsername: "release-bot" });
  });

  it("validateConfig preserves optional commit fields", () => {
    const result = githubProvider.validateConfig({
      label: "Release Bot",
      githubUsername: "release-bot",
      commitName: "Release Bot",
      commitEmail: "bot@example.com"
    });
    expect(result).toEqual({
      label: "Release Bot",
      githubUsername: "release-bot",
      commitName: "Release Bot",
      commitEmail: "bot@example.com"
    });
  });

  it("validateConfig returns an error string when githubUsername is missing", () => {
    const result = githubProvider.validateConfig({ label: "Release Bot" });
    expect(typeof result).toBe("string");
  });

  it("validateConfig returns an error string when label is empty", () => {
    const result = githubProvider.validateConfig({ label: "", githubUsername: "release-bot" });
    expect(typeof result).toBe("string");
  });

  it("registers each GitHub tool spec exactly once, github_bot_whoami first", () => {
    const names = githubProvider.tools.map((tool) => tool.name);
    expect(names[0]).toBe("github_bot_whoami");
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("github_bot_create_pull_request");
    expect(names).toContain("github_bot_push_branch");
    expect(names).toContain("github_bot_submit_pull_request_review");
    expect(names).toContain("github_bot_get_pull_request_checks");
    expect(names).toContain("github_bot_request_pull_request_reviewers");
  });

  it("exposes a manifest tool fragment for every live tool, plus a contributeActions hook", () => {
    expect(githubProvider.manifestTools.length).toBe(githubProvider.tools.length);
    expect(typeof githubProvider.contributeActions).toBe("function");
  });

  it("exposes credential and projection functions", () => {
    expect(typeof githubProvider.resolveCredential).toBe("function");
    expect(typeof githubProvider.projectPluginConfig).toBe("function");
  });
});
