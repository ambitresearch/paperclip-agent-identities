import type { PluginEntitiesClient } from "@paperclipai/plugin-sdk";

/**
 * Durable registry of Slack conversation keys that recovery must revisit.
 *
 * Each conversation is its own independently addressable entity record rather
 * than an entry inside one shared array. A shared array is read-modify-write:
 * two workers registering different conversations concurrently can each read
 * the same snapshot and the later write silently drops the earlier key, so
 * that queue would never be found by recovery again. Upserting one record per
 * conversation removes the shared write entirely -- concurrent registrations
 * touch disjoint rows and cannot overwrite one another.
 *
 * Records are company-scoped through `externalId`, so an agent that belongs to
 * more than one company keeps one registry per company instead of having the
 * second company's conversations rejected by a single-company discriminator.
 */

export const SLACK_CONVERSATION_REGISTRY_ENTITY_TYPE = "slack-conversation-registration" as const;

/** Bounds one agent+company registry; far above real conversation fan-out. */
export const SLACK_CONVERSATION_REGISTRY_LIMIT = 1_024;
const REGISTRY_PAGE_SIZE = 100;

export class SlackConversationRegistryFullError extends Error {}

function assertScope(agentId: string, companyId: string): void {
  if (!agentId.trim() || agentId !== agentId.trim()) {
    throw new Error("Slack conversation registry agent ID is invalid.");
  }
  if (!companyId.trim() || companyId !== companyId.trim()) {
    throw new Error("Slack conversation registry company ID is invalid.");
  }
}

/**
 * `externalId` carries the company so the host's per-scope uniqueness gives us
 * company isolation for free, without a second read to validate scope.
 */
function registrationExternalId(companyId: string, conversationKey: string): string {
  return `${companyId}:${conversationKey}`;
}

function parseRegistration(
  record: { externalId: string | null; status: string | null; data: Record<string, unknown> },
  companyId: string,
): string | null {
  if (record.status === "retired") return null;
  const externalId = record.externalId;
  if (typeof externalId !== "string") return null;
  const prefix = `${companyId}:`;
  if (!externalId.startsWith(prefix)) return null;
  const conversationKey = externalId.slice(prefix.length);
  if (!conversationKey) return null;
  // The in-record company is a consistency assertion, not the discriminator:
  // a mismatch means a corrupted or hand-edited row, so skip it loudly-safe.
  if (record.data?.companyId !== undefined && record.data.companyId !== companyId) return null;
  return conversationKey;
}

/**
 * List every conversation key registered for one agent within one company.
 *
 * Paginates to a hard bound. Exceeding the bound returns what was collected
 * rather than throwing: a partial recovery sweep for one oversized agent is
 * strictly better than aborting the sweep for every agent behind it.
 */
export async function listSlackConversationKeys(
  entities: PluginEntitiesClient,
  agentId: string,
  companyId: string,
): Promise<string[]> {
  assertScope(agentId, companyId);
  const keys: string[] = [];
  for (let offset = 0; offset < SLACK_CONVERSATION_REGISTRY_LIMIT; offset += REGISTRY_PAGE_SIZE) {
    const page = await entities.list({
      entityType: SLACK_CONVERSATION_REGISTRY_ENTITY_TYPE,
      scopeKind: "agent",
      scopeId: agentId,
      limit: REGISTRY_PAGE_SIZE,
      offset,
    });
    for (const record of page) {
      const conversationKey = parseRegistration(record, companyId);
      if (conversationKey) keys.push(conversationKey);
    }
    if (page.length < REGISTRY_PAGE_SIZE) break;
  }
  return keys;
}

/**
 * Register a conversation for recovery. Idempotent: the host upserts by
 * `externalId`, so repeat registrations of the same conversation collapse onto
 * one row and concurrent registrations of different conversations never race.
 */
export async function registerSlackConversationKey(
  entities: PluginEntitiesClient,
  agentId: string,
  companyId: string,
  conversationKey: string,
): Promise<void> {
  assertScope(agentId, companyId);
  if (!conversationKey.trim()) throw new Error("Slack conversation registry key is invalid.");
  await entities.upsert({
    entityType: SLACK_CONVERSATION_REGISTRY_ENTITY_TYPE,
    scopeKind: "agent",
    scopeId: agentId,
    externalId: registrationExternalId(companyId, conversationKey),
    status: "pending",
    // Secret-free by construction: the conversation key is an opaque hash and
    // no Slack text, user, token, session, or run identifier is persisted here.
    data: { version: 1, companyId, conversationKey },
  });
}

/**
 * Retire a conversation from the registry once its queue is fully drained.
 *
 * Without this the registry grows without bound and every recovery tick pays a
 * state read for conversations that will never have work again. Re-registration
 * on the next inbound turn is unconditional, so retiring early is safe.
 */
export async function unregisterSlackConversationKey(
  entities: PluginEntitiesClient,
  agentId: string,
  companyId: string,
  conversationKey: string,
): Promise<void> {
  assertScope(agentId, companyId);
  await entities.upsert({
    entityType: SLACK_CONVERSATION_REGISTRY_ENTITY_TYPE,
    scopeKind: "agent",
    scopeId: agentId,
    externalId: registrationExternalId(companyId, conversationKey),
    status: "retired",
    data: { version: 1, companyId, conversationKey, retired: true },
  });
}
