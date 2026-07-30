import type { PluginEntitiesClient, PluginEntityQuery, PluginEntityRecord, PluginEntityUpsert } from "@paperclipai/plugin-sdk";

/**
 * In-memory `ctx.entities` fake with the host's real upsert-by-externalId
 * semantics, so tests exercise the property the durable registry relies on:
 * distinct externalIds occupy distinct rows and cannot overwrite one another.
 */
export function makeEntities(
  rows: Map<string, PluginEntityRecord> = new Map(),
): PluginEntitiesClient & { rows: Map<string, PluginEntityRecord> } {
  let sequence = 0;
  const identity = (input: { entityType: string; scopeKind: string; scopeId?: string; externalId?: string }) =>
    `${input.entityType}|${input.scopeKind}|${input.scopeId ?? ""}|${input.externalId ?? ""}`;

  return {
    rows,
    async upsert(input: PluginEntityUpsert): Promise<PluginEntityRecord> {
      const key = identity(input);
      const existing = rows.get(key);
      const record: PluginEntityRecord = {
        id: existing?.id ?? `entity-${++sequence}`,
        entityType: input.entityType,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId ?? null,
        externalId: input.externalId ?? null,
        title: input.title ?? null,
        status: input.status ?? null,
        data: structuredClone(input.data),
        createdAt: existing?.createdAt ?? "2026-07-18T00:00:00.000Z",
        updatedAt: "2026-07-18T00:00:00.000Z",
      };
      rows.set(key, record);
      return structuredClone(record);
    },
    async list(query: PluginEntityQuery): Promise<PluginEntityRecord[]> {
      const matched = [...rows.values()].filter((record) =>
        (query.entityType === undefined || record.entityType === query.entityType) &&
        (query.scopeKind === undefined || record.scopeKind === query.scopeKind) &&
        (query.scopeId === undefined || record.scopeId === query.scopeId) &&
        (query.externalId === undefined || record.externalId === query.externalId));
      const offset = query.offset ?? 0;
      const limit = query.limit ?? matched.length;
      return matched.slice(offset, offset + limit).map((record) => structuredClone(record));
    },
  };
}
