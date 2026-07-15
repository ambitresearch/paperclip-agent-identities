import { describe, expect, it } from "vitest";

import { buildProviderRegistry } from "../src/core/provider-registry.js";
import type { IdentityProvider, ProviderToolSpec } from "../src/core/provider-contract.js";
import type { ResourceReference } from "../src/core/resource-reference.js";

function makeTool(
  name: string,
  live?: boolean,
  options: { uiActionInvocable?: boolean; requiresCredential?: boolean } = {},
): ProviderToolSpec<unknown, ResourceReference> {
  return {
    name,
    metadata: {},
    ...(live !== undefined ? { live } : {}),
    ...(options.uiActionInvocable !== undefined ? { uiActionInvocable: options.uiActionInvocable } : {}),
    ...(options.requiresCredential !== undefined ? { requiresCredential: options.requiresCredential } : {}),
    validateParams: (raw: unknown) => ({ ok: true, params: raw }),
    perform: async () => ({})
  };
}

function makeProvider(
  id: string,
  status: "enabled" | "coming-soon",
  toolsStatusOrExtra?: "enabled" | "coming-soon" | Partial<IdentityProvider>,
  tools: ReadonlyArray<ProviderToolSpec<unknown, ResourceReference>> = []
): IdentityProvider {
  const toolsStatus =
    typeof toolsStatusOrExtra === "string" ? toolsStatusOrExtra : undefined;
  const extra: Partial<IdentityProvider> =
    toolsStatusOrExtra && typeof toolsStatusOrExtra === "object" ? toolsStatusOrExtra : {};
  return {
    id,
    definition: {
      id,
      name: id,
      status,
      description: `${id} provider`,
      ...(toolsStatus !== undefined ? { toolsStatus } : {})
    },
    validateConfig: (raw: unknown) => raw,
    projectPluginConfig: (identities) => identities,
    resolveCredential: async () => ({ token: "x", secrets: [] }),
    tools,
    manifestTools: [],
    ...extra
  };
}

describe("buildProviderRegistry", () => {
  it("all() returns every provider in the given order", () => {
    const github = makeProvider("github", "enabled");
    const example = makeProvider("example", "coming-soon");
    const registry = buildProviderRegistry([github, example]);
    expect(registry.all().map((p) => p.id)).toEqual(["github", "example"]);
  });

  it("enabled() returns only providers whose status is enabled", () => {
    const github = makeProvider("github", "enabled");
    const example = makeProvider("example", "coming-soon");
    const registry = buildProviderRegistry([github, example]);
    expect(registry.enabled().map((p) => p.id)).toEqual(["github"]);
  });

  it("toolsEnabled() falls back to status when toolsStatus is unset, and honors toolsStatus when set", () => {
    const github = makeProvider("github", "enabled");
    const example = makeProvider("example", "coming-soon");
    const slack = makeProvider("slack", "coming-soon", "enabled");
    const registry = buildProviderRegistry([github, example, slack]);
    expect(registry.toolsEnabled().map((p) => p.id)).toEqual(["github", "slack"]);
  });

  it("liveTools() includes every tool from a toolsEnabled() provider, plus any individual tool marked live:true on an otherwise-dormant provider", () => {
    const github = makeProvider("github", "enabled", undefined, [makeTool("github_bot_whoami")]);
    const example = makeProvider("example", "coming-soon", undefined, [makeTool("example_whoami")]);
    const slack = makeProvider("slack", "coming-soon", "enabled", [
      makeTool("slack_bot_add_reaction"),
      makeTool("slack_bot_remove_reaction")
    ]);
    const registry = buildProviderRegistry([github, example, slack]);
    const liveNames = registry.liveTools().map(({ tool }) => tool.name);
    expect(liveNames).toContain("github_bot_whoami");
    expect(liveNames).toContain("slack_bot_add_reaction");
    expect(liveNames).toContain("slack_bot_remove_reaction");
    expect(liveNames).not.toContain("example_whoami");
  });

  it("liveTools() includes a tool marked live:true even on a coming-soon/not-toolsEnabled provider", () => {
    const example = makeProvider("example", "coming-soon", undefined, [
      makeTool("example_whoami", true)
    ]);
    const registry = buildProviderRegistry([example]);
    const liveNames = registry.liveTools().map(({ tool }) => tool.name);
    expect(liveNames).toContain("example_whoami");
  });

  it("uiInvocableLiveTools() uses toolsStatus rather than the settings UI status", () => {
    const slack = makeProvider("slack", "coming-soon", "enabled", [
      makeTool("slack_bot_whoami", undefined, {
        uiActionInvocable: true,
        requiresCredential: false,
      }),
    ]);
    const registry = buildProviderRegistry([slack]);

    expect(registry.uiInvocableLiveTools().map(({ tool }) => tool.name)).toEqual([
      "slack_bot_whoami",
    ]);
  });

  it("get() resolves a provider by id, including coming-soon ones", () => {
    const github = makeProvider("github", "enabled");
    const example = makeProvider("example", "coming-soon");
    const registry = buildProviderRegistry([github, example]);
    expect(registry.get("github")).toBe(github);
    expect(registry.get("example")).toBe(example);
    expect(registry.get("nope")).toBeUndefined();
  });

  it("webhooks() returns an empty array when no provider declares any", () => {
    const github = makeProvider("github", "enabled");
    const registry = buildProviderRegistry([github]);
    expect(registry.webhooks()).toEqual([]);
  });

  it("webhooks() collects declarations from any registered provider regardless of status", () => {
    const github = makeProvider("github", "enabled");
    const slack = makeProvider("slack", "coming-soon", {
      webhooks: [{ endpointKey: "slack-events", displayName: "Slack Events API" }]
    });
    const registry = buildProviderRegistry([github, slack]);
    const webhooks = registry.webhooks();
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].declaration.endpointKey).toBe("slack-events");
    expect(webhooks[0].provider).toBe(slack);
  });

  it("webhooks() supports a provider declaring multiple endpoints", () => {
    const slack = makeProvider("slack", "coming-soon", {
      webhooks: [
        { endpointKey: "slack-events", displayName: "Slack Events API" },
        { endpointKey: "slack-interactivity", displayName: "Slack Interactivity" }
      ]
    });
    const registry = buildProviderRegistry([slack]);
    expect(registry.webhooks().map(({ declaration }) => declaration.endpointKey)).toEqual([
      "slack-events",
      "slack-interactivity"
    ]);
  });
});
