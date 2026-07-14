// src/providers/index.ts
import { buildProviderRegistry } from "../core/provider-registry.js";
import type { ProviderRegistry } from "../core/provider-registry.js";
import type { IdentityProvider } from "../core/provider-contract.js";
import { githubProvider } from "./github/index.js";
import { exampleProvider } from "./example/index.js";
import { slackProvider } from "./slack/index.js";

// The ONE place that knows the concrete set of identity providers and their
// order. Adding a provider = import its module here and append it to this array.
// Nothing else in the plugin (worker, manifest) references a specific provider —
// they consume the registry this composition root builds.
export const ALL_PROVIDERS: readonly IdentityProvider[] = [githubProvider, exampleProvider, slackProvider];

export function createProviderRegistry(): ProviderRegistry {
  return buildProviderRegistry([...ALL_PROVIDERS]);
}

// The Settings-UI adapter registry lives in a separate composition root
// (./settings-index.js), NOT re-exported from here: this module imports the
// concrete server-side IdentityProvider implementations above (which touch
// `node:crypto`/filesystem via app-manifest/credentials modules), so anything
// importing from here is unsafe for the client-side Settings UI bundle. See
// settings-index.ts for the UI-safe equivalent SettingsPage.tsx consumes.
