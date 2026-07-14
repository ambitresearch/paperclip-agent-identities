import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "./agent-identity.js";
import type { ResourceReference } from "./resource-reference.js";

export type { ResourceReference };

export type IdentityProviderStatus = "enabled" | "coming-soon";

export interface IdentityProviderDefinition {
  readonly id: string;
  readonly name: string;
  // Gates the provider's presence in agent-facing surfaces: the settings UI
  // provider picker (src/ui/SettingsPage.tsx) and the shared provider list
  // (src/shared/types.ts's SUPPORTED_IDENTITY_PROVIDERS). A provider can be
  // "coming-soon" here (its settings/config wiring isn't finished) while its
  // tool surface is independently live — see `toolsStatus`.
  readonly status: IdentityProviderStatus;
  // Gates whether the provider's `tools`/`manifestTools` are actually wired
  // into the runtime tool registry (src/worker.ts) and the composed plugin
  // manifest (src/manifest.ts). Defaults to `status` when omitted, so any
  // provider that doesn't set this explicitly keeps the original
  // status-gates-everything behavior. Set this independently of `status` when
  // a provider's tool implementation is functionally complete and tested
  // before its settings/config UI lands (e.g. Slack: DRO-973's
  // slack_bot_post_message tool is live even though the Slack settings UI,
  // DRO-976/1006, is still pending).
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
}
