// src/providers/index.ts
import { buildProviderRegistry } from "../core/provider-registry.js";
import type { ProviderRegistry } from "../core/provider-registry.js";
import type { IdentityProvider } from "../core/provider-contract.js";
import { githubProvider } from "./github/index.js";
import { exampleProvider } from "./example/index.js";

// The ONE place that knows the concrete set of identity providers and their
// order. Adding a provider = import its module here and append it to this array.
// Nothing else in the plugin (worker, manifest) references a specific provider —
// they consume the registry this composition root builds.
export const ALL_PROVIDERS: readonly IdentityProvider[] = [githubProvider, exampleProvider];

export function createProviderRegistry(): ProviderRegistry {
  return buildProviderRegistry([...ALL_PROVIDERS]);
}
