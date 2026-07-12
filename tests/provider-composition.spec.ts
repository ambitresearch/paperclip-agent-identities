// tests/provider-composition.spec.ts
import { describe, it, expect } from "vitest";
import { ALL_PROVIDERS, createProviderRegistry } from "../src/providers/index.js";
import { githubProvider } from "../src/providers/github/index.js";
import { exampleProvider } from "../src/providers/example/index.js";
import { slackProvider } from "../src/providers/slack/index.js";

describe("provider composition root", () => {
  it("registers github, example, then slack, in order", () => {
    expect(ALL_PROVIDERS.map((p) => p.id)).toEqual(["github", "example", "slack"]);
  });

  it("enables only providers whose status is enabled", () => {
    const registry = createProviderRegistry();
    expect(registry.enabled().map((p) => p.id)).toEqual(["github"]);
  });

  it("resolves providers by id, including coming-soon ones", () => {
    const registry = createProviderRegistry();
    expect(registry.get("github")).toBe(githubProvider);
    expect(registry.get("example")).toBe(exampleProvider);
    expect(registry.get("slack")).toBe(slackProvider);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("composes live manifest tools from enabled providers only", () => {
    const registry = createProviderRegistry();
    const manifestToolNames = registry
      .enabled()
      .flatMap((provider) => provider.manifestTools as ReadonlyArray<{ name: string }>)
      .map((tool) => tool.name);

    // GitHub (enabled) contributes its tools...
    expect(manifestToolNames).toContain("github_bot_whoami");
    expect(manifestToolNames).toContain("github_bot_create_pull_request");
    expect(manifestToolNames).toContain("github_bot_push_branch");

    // ...the example is coming-soon, so its tool is absent from the live
    // manifest EVEN THOUGH it ships a manifest fragment. The `.enabled()`
    // filter — not an empty array — is what gates it out.
    expect(manifestToolNames).not.toContain("example_whoami");
    expect(exampleProvider.manifestTools).toHaveLength(1);
  });

  it("keeps all live tool definitions provider-owned", () => {
    expect(githubProvider.tools.map((tool) => tool.name)).toEqual([
      "github_bot_whoami", "github_bot_create_pull_request", "github_bot_push_branch",
    ]);
    expect(githubProvider.manifestTools.map((tool) => (tool as { name: string }).name)).toEqual([
      "github_bot_whoami", "github_bot_create_pull_request", "github_bot_push_branch",
    ]);
  });
});
