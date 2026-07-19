import { processLocalIdentityMutationKeys } from "./core/process-local-mutation-queue.js";

export const CONFIG_STATE_KEY = "bot-identity-config";
export const CONFIG_SCOPE = { scopeKind: "instance" as const, stateKey: CONFIG_STATE_KEY };

export function configMutationLockKeys(companyId: string, agentId: string): readonly string[] {
  return processLocalIdentityMutationKeys(CONFIG_STATE_KEY, companyId, agentId);
}
