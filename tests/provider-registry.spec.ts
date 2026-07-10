import { describe, expect, it } from "vitest";

import { buildProviderRegistry } from "../src/core/provider-registry.js";
import type { IdentityProvider } from "../src/core/provider-contract.js";

function makeProvider(id: string, status: "enabled" | "coming-soon"): IdentityProvider {
  return {
    id,
    definition: { id, name: id, status, description: `${id} provider` },
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

  it("get() resolves a provider by id, including coming-soon ones", () => {
    const github = makeProvider("github", "enabled");
    const example = makeProvider("example", "coming-soon");
    const registry = buildProviderRegistry([github, example]);
    expect(registry.get("github")).toBe(github);
    expect(registry.get("example")).toBe(example);
    expect(registry.get("nope")).toBeUndefined();
  });
});
