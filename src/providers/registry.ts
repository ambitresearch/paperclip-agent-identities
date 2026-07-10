import { SUPPORTED_IDENTITY_PROVIDERS, type IdentityProviderDefinition, type IdentityProviderId } from "../shared/types.js";

/**
 * A provider adapter binds an identity provider id to its static definition.
 * Later tasks (config projection, credential adapter, tool specs) extend this
 * contract with provider-specific behavior; this task only introduces the
 * registry itself and seeds it with the providers already declared in
 * `shared/types.ts`.
 */
export type ProviderAdapter = {
  id: IdentityProviderId;
  definition: IdentityProviderDefinition;
};

const registry = new Map<string, ProviderAdapter>();

/**
 * Registers a provider adapter. Fails closed on duplicate ids so a later
 * adapter can never silently shadow an earlier one.
 */
export function registerProvider(adapter: ProviderAdapter): void {
  if (registry.has(adapter.id)) {
    throw new Error(`Provider adapter '${adapter.id}' is already registered.`);
  }
  registry.set(adapter.id, adapter);
}

/**
 * Looks up a provider adapter by id. Fails closed on unknown ids rather than
 * returning undefined, matching the fail-closed conventions used elsewhere
 * in this plugin (identity-policy.ts, credential-sidecar.ts).
 */
export function getProvider(id: IdentityProviderId): ProviderAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    throw new Error(`Unknown provider adapter '${id}'.`);
  }
  return adapter;
}

export function hasProvider(id: IdentityProviderId): boolean {
  return registry.has(id);
}

export function listProviders(): ProviderAdapter[] {
  return Array.from(registry.values());
}

function seedDefaultProviders(): void {
  for (const definition of SUPPORTED_IDENTITY_PROVIDERS) {
    if (!registry.has(definition.id)) {
      registry.set(definition.id, { id: definition.id, definition });
    }
  }
}

seedDefaultProviders();
