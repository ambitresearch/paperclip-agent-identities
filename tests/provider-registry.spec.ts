import { describe, expect, it } from "vitest";

import { buildProviderRegistry } from "../src/core/provider-registry.js";
import type { IdentityProvider } from "../src/core/provider-contract.js";

function makeProvider(
  id: string,
  status: "enabled" | "coming-soon",
  extra: Partial<IdentityProvider> = {}
): IdentityProvider {
  return {
    id,
    definition: { id, name: id, status, description: `${id} provider` },
    validateConfig: (raw: unknown) => raw,
    projectPluginConfig: (identities) => identities,
    resolveCredential: async () => ({ token: "x", secrets: [] }),
    tools: [],
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
