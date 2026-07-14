import type { IdentityProvider, ProviderToolSpec } from "./provider-contract.js";
import type { ResourceReference } from "./resource-reference.js";

/**
 * A tool paired with the provider that owns it. Returned by `liveTools()` so
 * generic consumers (worker/manifest) can register a tool without needing to
 * know which provider it came from.
 */
export interface LiveProviderTool {
  readonly provider: IdentityProvider;
  readonly tool: ProviderToolSpec<unknown, ResourceReference>;
}

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
  /**
   * Every tool that should actually be composed into the live worker/manifest
   * surface right now: all tools from `enabled()` providers, PLUS any
   * individual tool from a "coming-soon" provider that opts in via
   * `toolSpec.live: true` (e.g. a credential-free self-check tool shipping
   * ahead of the rest of that provider's surface). This is the ONE generic
   * seam worker.ts/manifest.ts should use instead of branching on provider id.
   */
  liveTools(): readonly LiveProviderTool[];
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
    },
    liveTools(): readonly LiveProviderTool[] {
      const live: LiveProviderTool[] = [];
      for (const provider of ordered) {
        const providerIsEnabled = provider.definition.status === "enabled";
        for (const tool of provider.tools) {
          if (providerIsEnabled || tool.live === true) {
            live.push({
              provider: provider as IdentityProvider,
              tool: tool as ProviderToolSpec<unknown, ResourceReference>,
            });
          }
        }
      }
      return live;
    }
  };
}
