// Generic core identity resolution types, shared across provider adapters.
import type { ToolRunContext } from "@paperclipai/plugin-sdk";

export interface ResolvedAgentIdentity<TIdentity> {
  agentId: string;
  identity: TIdentity;
}

export interface ProjectedPluginConfig<TIdentity> {
  readonly identities: Record<string, TIdentity>;
}

export function resolveAgentIdentity<TIdentity>(
  projectedConfig: ProjectedPluginConfig<TIdentity>,
  runContext: ToolRunContext,
): ResolvedAgentIdentity<TIdentity> {
  const identity = projectedConfig.identities[runContext.agentId];
  if (!identity) {
    throw new Error(`No agent identity configured for agent '${runContext.agentId}'.`);
  }
  return { agentId: runContext.agentId, identity };
}
