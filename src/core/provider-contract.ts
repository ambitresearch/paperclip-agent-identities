import type { PluginContext, PluginWebhookInput, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "./agent-identity.js";
import type { ResourceReference } from "./resource-reference.js";

export type { ResourceReference };

// Generic manifest-facing webhook endpoint declaration a provider can
// contribute. Mirrors `manifestTools`/`contributeActions`: this is the ONE
// seam `src/manifest.ts`/`src/worker.ts` use to learn about inbound HTTP
// endpoints, so adding Slack's Events API ingress (DRO-975) requires no
// provider-specific branch in either file. Shape matches the SDK's
// `PluginWebhookDeclaration` one-for-one; kept as a separate provider-owned
// type so this module does not otherwise depend on manifest types.
export interface ProviderWebhookDeclaration {
  readonly endpointKey: string;
  readonly displayName: string;
  readonly description?: string;
}

export type IdentityProviderStatus = "enabled" | "coming-soon";

export interface IdentityProviderDefinition {
  readonly id: string;
  readonly name: string;
  // Gates the provider's presence in agent-facing surfaces: the settings UI
  // provider picker (src/ui/SettingsPage.tsx) and the shared provider list
  // (src/shared/types.ts's SUPPORTED_IDENTITY_PROVIDERS). A provider can be
  // "coming-soon" here (its full tool surface isn't finished, even if its
  // setup/config UI is live) while a subset of its tools is independently
  // live — see `toolsStatus`.
  readonly status: IdentityProviderStatus;
  // Gates whether the provider's `tools`/`manifestTools` are actually wired
  // into the runtime tool registry (src/worker.ts) and the composed plugin
  // manifest (src/manifest.ts). Defaults to `status` when omitted, so any
  // provider that doesn't set this explicitly keeps the original
  // status-gates-everything behavior. Set this independently of `status` when
  // a provider's tool implementation is functionally complete and tested
  // before its *entire* tool surface lands (e.g. Slack: DRO-973's
  // slack_bot_post_message and DRO-972's slack_bot_whoami tools are live
  // even though `status` stays "coming-soon" until the remaining
  // react/lookup-channel tools, DRO-974/975, land — independent of the
  // Slack settings UI, which is already live, see src/ui/SettingsPage.tsx).
  readonly toolsStatus?: IdentityProviderStatus;
  readonly description: string;
}

export interface ResolvedCredential {
  readonly token: string;
  readonly secrets: readonly string[];
}

export type ParamsValidation =
  | { readonly ok: true; readonly params: unknown }
  | { readonly ok: false; readonly error: string };

export interface ProviderToolExecution<TIdentity, TRef extends ResourceReference> {
  // `null` when the tool's spec sets `requiresCredential: false` (e.g. whoami):
  // the pipeline skips credential resolution entirely and no secret is minted.
  // Credentialed tools (create-PR, push-branch) are guaranteed a non-null token
  // by the pipeline and narrow it defensively in `perform`.
  readonly token: string | null;
  readonly identity: ResolvedAgentIdentity<TIdentity>;
  readonly resourceRef: TRef | null;
  readonly params: unknown;
  readonly ctx: PluginContext;
  readonly runCtx: ToolRunContext;
}

// Async, context-aware resource-ref resolution (Option A). The pipeline awaits
// this BEFORE resolving any credential, so a tool can derive its ref from a
// param OR from git/workspace state and deny disallowed targets before a secret
// exists. The adapter owns its own per-denial audit logging and returns a plain
// error string on denial.
export interface ResourceRefResolverInput<TIdentity> {
  readonly params: unknown;
  readonly identity: ResolvedAgentIdentity<TIdentity>;
  readonly ctx: PluginContext;
  readonly runCtx: ToolRunContext;
}

export type ResourceRefResolution<TRef extends ResourceReference> =
  | { readonly ok: true; readonly ref: TRef | null }
  | { readonly ok: false; readonly error: string };

export interface ProviderToolSpec<TIdentity, TRef extends ResourceReference> {
  readonly name: string;
  readonly metadata: unknown;
  // When `false`, the pipeline SKIPS credential resolution (step 4) and calls
  // `perform` with `token: null`. Defaults to `true` (omit for credentialed
  // tools). Identity-metadata-only tools (whoami) set this to `false` so they
  // provably never touch a secret. This keeps the security invariant intact:
  // credentials are still resolved just-before-`perform` for every tool that
  // needs them, and never for tools that don't.
  readonly requiresCredential?: boolean;
  // When `true`, this individual tool is composed into the live worker/manifest
  // surface even while its owning provider's `definition.status` is
  // "coming-soon" (e.g. Slack's credential-free `slack_bot_whoami` self-check,
  // DRO-972, shipping ahead of the message/reply/react tools that gate the
  // provider itself to "enabled"). Defaults to `false`/omitted -- a coming-soon
  // provider's tools stay dormant by default; each tool opts in individually.
  // This keeps `src/worker.ts`/`src/manifest.ts` provider-agnostic: they ask
  // the registry for "live tools", never for a named provider's status.
  readonly live?: boolean;
  // When `true`, this tool is ALSO composed into the plugin's `ctx.actions`
  // surface (same name, same pipeline handler) so the Settings UI can invoke
  // it via `usePluginAction`. `ctx.tools.register` handlers are reachable
  // only through the agent-facing `executeTool` RPC method, never through
  // `performAction`/`usePluginAction` (PLUGIN_SPEC.md §13.9 vs §13.10) -- a
  // UI-facing capability check needs its own action registration even though
  // an identical handler already exists as a tool. Reserved for
  // credential-free tools (`requiresCredential: false`) whose `perform` only
  // reads already-validated public identity fields: `performAction` callers
  // come from a Settings UI page, not an authenticated agent run, so this
  // must never be set on a tool that resolves a credential. This is a
  // generic, provider-agnostic seam (see `ProviderRegistry.liveTools()` in
  // `src/core/provider-registry.ts` and its use in `src/worker.ts`) -- no
  // provider-specific branch is added to register it.
  readonly uiActionInvocable?: boolean;
  validateParams(raw: unknown): ParamsValidation;
  resolveResourceRef?(
    input: ResourceRefResolverInput<TIdentity>,
  ): Promise<ResourceRefResolution<TRef>>;
  perform(execution: ProviderToolExecution<TIdentity, TRef>): Promise<unknown>;
}

export interface CredentialResolverInput<TIdentity> {
  readonly identity: ResolvedAgentIdentity<TIdentity>;
  readonly ctx: PluginContext;
}

export interface IdentityProvider<
  TIdentity = unknown,
  TRef extends ResourceReference = ResourceReference,
> {
  readonly id: string;
  readonly definition: IdentityProviderDefinition;
  validateConfig(raw: unknown): TIdentity | string;
  projectPluginConfig(identities: Record<string, unknown>): Record<string, TIdentity>;
  resolveCredential(input: CredentialResolverInput<TIdentity>): Promise<ResolvedCredential>;
  readonly tools: ReadonlyArray<ProviderToolSpec<TIdentity, TRef>>;
  contributeActions?(ctx: PluginContext): void;
  readonly manifestTools: ReadonlyArray<unknown>;
  // Optional inbound-webhook surface a provider contributes (e.g. Slack's
  // HTTP Events API ingress, DRO-975). Both are optional and provider-owned:
  // `webhooks` feeds `src/manifest.ts`'s `webhooks` array generically, and
  // `handleWebhook` is dispatched by `src/worker.ts`'s single `onWebhook`
  // hook by matching `input.endpointKey` against each provider's declared
  // `endpointKey`s -- no provider-specific branch in either file.
  readonly webhooks?: ReadonlyArray<ProviderWebhookDeclaration>;
  handleWebhook?(input: PluginWebhookInput, ctx: PluginContext): Promise<void>;
}
