import { describe, expect, it } from "vitest";

import { buildProviderRegistry } from "../src/core/provider-registry.js";
import type { IdentityProvider } from "../src/core/provider-contract.js";

function makeProvider(
  id: string,
  status: "enabled" | "coming-soon",
  toolsLive?: boolean
): IdentityProvider {
  return {
    id,
    definition: {
      id,
      name: id,
      status,
      description: `${id} provider`,
      ...(toolsLive !== undefined ? { toolsLive } : {})
    },
    validateConfig: (raw: unknown) => raw,
    projectPluginConfig: (identities) => identities,
    resolveCredential: async () => ({ token: "x", secrets: [] }),
    tools: [],
    manifestTools: []
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

  it("liveTools() includes enabled providers plus coming-soon providers that opt in via toolsLive", () => {
    const github = makeProvider("github", "enabled");
    const example = makeProvider("example", "coming-soon");
    const slack = makeProvider("slack", "coming-soon", true);
    const registry = buildProviderRegistry([github, example, slack]);
    expect(registry.liveTools().map((p) => p.id)).toEqual(["github", "slack"]);
  });

  it("get() resolves a provider by id, including coming-soon ones", () => {
    const github = makeProvider("github", "enabled");
    const example = makeProvider("example", "coming-soon");
    const registry = buildProviderRegistry([github, example]);
    expect(registry.get("github")).toBe(github);
    expect(registry.get("example")).toBe(example);
    expect(registry.get("nope")).toBeUndefined();
  });
});
