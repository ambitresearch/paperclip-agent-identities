// tests/provider-composition.spec.ts
import { describe, it, expect } from "vitest";
import { ALL_PROVIDERS, createProviderRegistry } from "../src/providers/index.js";
import { githubProvider } from "../src/providers/github/index.js";
import { exampleProvider } from "../src/providers/example/index.js";
import { slackProvider } from "../src/providers/slack/index.js";
import manifest from "../src/manifest.js";

describe("provider composition root", () => {
  it("registers github, example, then slack, in order", () => {
    expect(ALL_PROVIDERS.map((p) => p.id)).toEqual(["github", "example", "slack"]);
  });

  it("enables providers whose status is enabled", () => {
    const registry = createProviderRegistry();
    // Slack flipped to "enabled" now that slack_bot_lookup_channel
    // (DRO-975/DRO-1160) landed -- the last documented backlog item gating
    // slackProviderDefinition.status.
    expect(registry.enabled().map((p) => p.id)).toEqual(["github", "slack"]);
  });

  it("composes the live tool surface from toolsEnabled()", () => {
    const registry = createProviderRegistry();
    expect(registry.toolsEnabled().map((p) => p.id)).toEqual(["github", "slack"]);
  });

  it("resolves providers by id, including coming-soon ones", () => {
    const registry = createProviderRegistry();
    expect(registry.get("github")).toBe(githubProvider);
    expect(registry.get("example")).toBe(exampleProvider);
    expect(registry.get("slack")).toBe(slackProvider);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("composes live tools from enabled providers plus opted-in tools from coming-soon providers", () => {
    const registry = createProviderRegistry();
    const liveToolNames = registry.liveTools().map(({ tool }) => tool.name);

    // GitHub (enabled) contributes its tools...
    expect(liveToolNames).toContain("github_bot_whoami");
    expect(liveToolNames).toContain("github_bot_create_pull_request");
    expect(liveToolNames).toContain("github_bot_push_branch");

    // ...Slack is now "enabled" as a provider too, and its whoami (DRO-972),
    // post-message (DRO-973), reaction (DRO-974), and lookup-channel
    // (DRO-975/DRO-1160) tools are all live.
    expect(liveToolNames).toContain("slack_bot_whoami");
    expect(liveToolNames).toContain("slack_bot_post_message");
    expect(liveToolNames).toContain("slack_bot_add_reaction");
    expect(liveToolNames).toContain("slack_bot_remove_reaction");
    expect(liveToolNames).toContain("slack_bot_lookup_channel");

    // ...the example is coming-soon and has no `live` tool, so its tool is
    // absent from the live set EVEN THOUGH it ships a manifest fragment. The
    // `liveTools()` filter -- not an empty array -- is what gates it out.
    expect(liveToolNames).not.toContain("example_whoami");
    expect(exampleProvider.manifestTools).toHaveLength(1);
  });

  it("advertises the manifest tool fragment for slack_bot_whoami", () => {
    const manifestToolNames = (manifest.tools as ReadonlyArray<{ name: string }>).map((tool) => tool.name);
    expect(manifestToolNames).toContain("slack_bot_whoami");
    expect(manifestToolNames).toContain("slack_bot_lookup_channel");
    expect(manifestToolNames).not.toContain("example_whoami");
    expect(slackProvider.definition.status).toBe("enabled");
  });

  it("keeps all live tool definitions provider-owned", () => {
    expect(githubProvider.tools.map((tool) => tool.name)).toEqual([
      "github_bot_whoami", "github_bot_create_pull_request", "github_bot_push_branch",
      "github_bot_submit_pull_request_review",
    ]);
    expect(githubProvider.manifestTools.map((tool) => (tool as { name: string }).name)).toEqual([
      "github_bot_whoami", "github_bot_create_pull_request", "github_bot_push_branch",
      "github_bot_submit_pull_request_review",
    ]);
  });
});
