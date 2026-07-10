import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "./agent-identity.js";
import type { IdentityProvider, ProviderToolSpec, ResolvedCredential } from "./provider-contract.js";
import type { ResourceReference } from "./resource-reference.js";

export interface ProviderToolPipelineDeps<TIdentity> {
  resolveIdentity(ctx: PluginContext, runCtx: ToolRunContext): Promise<ResolvedAgentIdentity<TIdentity>>;
  redactSecrets<T>(value: T, secrets: readonly string[]): T;
}

export interface RegisteredProviderTool {
  readonly name: string;
  readonly metadata: unknown;
  handler(params: unknown, runCtx: ToolRunContext): Promise<unknown>;
}

export function createProviderTool<TIdentity, TRef extends ResourceReference>(
  provider: IdentityProvider<TIdentity, TRef>,
  toolSpec: ProviderToolSpec<TIdentity, TRef>,
  ctx: PluginContext,
  deps: ProviderToolPipelineDeps<TIdentity>,
): RegisteredProviderTool {
  return {
    name: toolSpec.name,
    metadata: toolSpec.metadata,
    async handler(rawParams, runCtx) {
      // Step 1: validate params — deny malformed input before any secret work.
      const validation = toolSpec.validateParams(rawParams);
      if (!validation.ok) {
        return { error: validation.error };
      }
      const params = validation.params;

      // Step 2: resolve agent identity — fail closed on any error.
      let identity: ResolvedAgentIdentity<TIdentity>;
      try {
        identity = await deps.resolveIdentity(ctx, runCtx);
      } catch (error) {
        const message = error instanceof Error ? error.message : "identity resolution failed";
        return { error: `${toolSpec.name} failed closed for agent '${runCtx.agentId}': ${message}` };
      }

      // Step 3: resolve resource ref — the adapter derives the ref (from a param
      // or from git/workspace state) and denies disallowed targets BEFORE any
      // secret resolution. The adapter logs its own per-denial audit detail.
      let resourceRef: TRef | null = null;
      if (toolSpec.resolveResourceRef) {
        const resolution = await toolSpec.resolveResourceRef({ params, identity, ctx, runCtx });
        if (!resolution.ok) {
          return { error: resolution.error };
        }
        resourceRef = resolution.ref;
      }

      // Step 4: resolve credential — FIRST secret access, only after all denials.
      // Skipped entirely when the tool declares `requiresCredential: false`
      // (identity-metadata-only tools such as whoami), so those tools provably
      // never mint or touch a secret.
      let credential: ResolvedCredential | null = null;
      if (toolSpec.requiresCredential !== false) {
        try {
          credential = await provider.resolveCredential({ identity, ctx });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await ctx.activity.log({
            companyId: runCtx.companyId,
            entityType: "run",
            entityId: runCtx.runId,
            message: `${toolSpec.name} failed: credential resolution`,
            metadata: {
              agentId: runCtx.agentId,
              runId: runCtx.runId,
              outcome: "credential_resolution_failed",
              reason,
            },
          });
          return { error: "Failed to resolve agent identity authentication credentials." };
        }
      }

      // Step 5: perform — the only provider-specific API/git step (activity log lives here).
      const result = await toolSpec.perform({
        token: credential?.token ?? null,
        identity,
        resourceRef,
        params,
        ctx,
        runCtx,
      });

      // Step 6: redact — never leak the token or any resolved secret.
      return deps.redactSecrets(result, credential?.secrets ?? []);
    },
  };
}
