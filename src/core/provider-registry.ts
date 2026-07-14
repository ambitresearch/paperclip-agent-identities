import type { IdentityProvider, ProviderToolSpec, ProviderWebhookDeclaration } from "./provider-contract.js";
import type { ResourceReference } from "./resource-reference.js";

/**
 * A webhook endpoint declaration paired with the provider that owns it, and
 * that provider's handler. Returned by `webhooks()` so generic consumers
 * (worker/manifest) can compose inbound HTTP endpoints without a
 * provider-specific branch (mirrors `LiveProviderTool`/`liveTools()`).
 */
export interface ProviderWebhook {
  readonly provider: IdentityProvider;
  readonly declaration: ProviderWebhookDeclaration;
}

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
  /**
   * Every tool that should actually be composed into the live worker/manifest
   * surface right now: all tools from `toolsEnabled()` providers (tool
   * surface is live, independent of the provider's settings-UI `status`),
   * PLUS any individual tool from a provider whose tool surface isn't
   * (yet) enabled that opts in via `toolSpec.live: true` (e.g. a
   * credential-free self-check tool shipping ahead of the rest of that
   * provider's surface). This is the ONE generic seam worker.ts/manifest.ts
   * should use instead of branching on provider id.
   */
  liveTools(): readonly LiveProviderTool[];
  /**
   * The subset of `liveTools()` that also opts in via
   * `toolSpec.uiActionInvocable: true` -- i.e. tools the Settings UI needs to
   * invoke via `usePluginAction`/`ctx.actions.register`, not just an agent via
   * `ctx.tools.register`/`executeTool`. Kept as its own generic accessor
   * (rather than having `src/worker.ts` filter `liveTools()` itself) so the
   * "which tools also become actions" policy lives in one place.
   */
  uiInvocableLiveTools(): readonly LiveProviderTool[];
  /**
   * Every webhook endpoint declared by any registered provider (regardless
   * of provider `status` -- a "coming-soon" provider can still ship inbound
   * ingress ahead of its tool surface, same precedent as `live` tools). The
   * ONE generic seam `src/manifest.ts` uses to build the manifest's
   * `webhooks` array and `src/worker.ts`'s `onWebhook` uses to find the
   * owning provider by `endpointKey` -- no provider-specific branch in
   * either file.
   */
  webhooks(): readonly ProviderWebhook[];
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
    },
    liveTools(): readonly LiveProviderTool[] {
      const live: LiveProviderTool[] = [];
      for (const provider of ordered) {
        const toolsAreEnabled =
          (provider.definition.toolsStatus ?? provider.definition.status) === "enabled";
        for (const tool of provider.tools) {
          if (toolsAreEnabled || tool.live === true) {
            live.push({
              provider: provider as IdentityProvider,
              tool: tool as ProviderToolSpec<unknown, ResourceReference>,
            });
          }
        }
      }
      return live;
    },
    uiInvocableLiveTools(): readonly LiveProviderTool[] {
      const live: LiveProviderTool[] = [];
      for (const provider of ordered) {
        const toolsAreEnabled =
          (provider.definition.toolsStatus ?? provider.definition.status) === "enabled";
        for (const tool of provider.tools) {
          if ((toolsAreEnabled || tool.live === true) && tool.uiActionInvocable === true) {
            live.push({
              provider: provider as IdentityProvider,
              tool: tool as ProviderToolSpec<unknown, ResourceReference>,
            });
          }
        }
      }
      return live;
    },
    webhooks(): readonly ProviderWebhook[] {
      const declared: ProviderWebhook[] = [];
      for (const provider of ordered) {
        for (const declaration of provider.webhooks ?? []) {
          declared.push({ provider: provider as IdentityProvider, declaration });
        }
      }
      return declared;
    }
  };
}
