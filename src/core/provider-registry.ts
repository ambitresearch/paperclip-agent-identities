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
  /**
   * Only providers whose tool surface is live: `definition.toolsStatus` if
   * set, else falls back to `definition.status`. This — NOT `enabled()` — is
   * what gates live tool registration (src/worker.ts) and manifest tool
   * composition (src/manifest.ts). `enabled()` continues to gate
   * settings/config UI surfaces. A provider's tool surface can go live ahead
   * of (or behind) its settings UI by setting `toolsStatus` independently of
   * `status`.
   */
  toolsEnabled(): readonly IdentityProvider[];
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
    toolsEnabled(): readonly IdentityProvider[] {
      return ordered.filter(
        (provider) => (provider.definition.toolsStatus ?? provider.definition.status) === "enabled"
      );
    },
    get(id: string): IdentityProvider | undefined {
      return byId.get(id);
    }
  };
}
