import type { IdentityProvider } from "./provider-contract.js";

/**
 * The generic registry mechanism. It does NOT know about any concrete
 * provider — that composition lives in `src/providers/index.ts` (the
 * composition root), which imports this and feeds it the concrete provider
 * list in order.
 */
export interface ProviderRegistry {
  /** Every registered provider, in the order they were supplied. */
  all(): readonly IdentityProvider[];
  /** Only providers whose `definition.status` is `"enabled"`. */
  enabled(): readonly IdentityProvider[];
  /** Look up a provider by id, including "coming-soon" ones. */
  get(id: string): IdentityProvider | undefined;
}

export function buildProviderRegistry(providers: readonly IdentityProvider[]): ProviderRegistry {
  const ordered = [...providers];
  const byId = new Map(ordered.map((provider) => [provider.id, provider] as const));

  return {
    all(): readonly IdentityProvider[] {
      return ordered;
    },
    enabled(): readonly IdentityProvider[] {
      return ordered.filter((provider) => provider.definition.status === "enabled");
    },
    get(id: string): IdentityProvider | undefined {
      return byId.get(id);
    }
  };
}
