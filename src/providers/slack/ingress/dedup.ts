export interface SlackDedupStateClient {
  get(key: { scopeKind: "agent"; scopeId: string; namespace?: string; stateKey: string }): Promise<unknown>;
  set(key: { scopeKind: "agent"; scopeId: string; namespace?: string; stateKey: string }, value: unknown): Promise<void>;
}

const DEDUP_NAMESPACE = "slack-ingress";

function stateKeyFor(eventId: string): string {
  return `event:${eventId}`;
}

/**
 * Deduplicates inbound Slack events per agent so a Slack-side retry (e.g. the
 * Events API redelivering after a slow/missing ack, per
 * openwiki/domain/slack-provider-design.md's DRO-975 acceptance criteria:
 * "Deduplicate retries/event IDs to prevent duplicate Paperclip work") does
 * not cause the same event to be processed twice by the same agent.
 *
 * Returns `true` the first time a given (agentId, eventId) pair is seen —
 * the caller should proceed with routing/processing. Returns `false` on any
 * subsequent call with the same pair — the caller must ack the delivery
 * without doing any further work (Slack only cares that the endpoint
 * returned 200; re-processing is the thing being prevented, not the ack).
 */
export async function shouldProcessSlackEvent(
  state: SlackDedupStateClient,
  agentId: string,
  eventId: string
): Promise<boolean> {
  const key = { scopeKind: "agent" as const, scopeId: agentId, namespace: DEDUP_NAMESPACE, stateKey: stateKeyFor(eventId) };
  const existing = await state.get(key);
  if (existing) {
    return false;
  }
  await state.set(key, true);
  return true;
}
