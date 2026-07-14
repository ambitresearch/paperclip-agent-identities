export interface SlackDedupStateClient {
  get(key: { scopeKind: "agent"; scopeId: string; namespace?: string; stateKey: string }): Promise<unknown>;
  set(key: { scopeKind: "agent"; scopeId: string; namespace?: string; stateKey: string }, value: unknown): Promise<void>;
}

// NOTE on atomicity (residual risk, documented rather than silently assumed
// away): the `@paperclipai/plugin-sdk` PluginStateClient this module is built
// on (see node_modules/@paperclipai/plugin-sdk/dist/types.d.ts) exposes only
// get/set/delete against the `plugin_state` table (unique on
// (plugin_id, scope_kind, scope_id, namespace, state_key) — see
// doc/plugins/PLUGIN_SPEC.md §21.3). There is no compare-and-set, conditional
// insert, or atomic increment primitive exposed today. That means a true
// read-then-write race — two concurrent deliveries of the same (agentId,
// eventId) both calling get() before either call's set() lands — cannot be
// closed from this module alone; whichever call's set() commits last simply
// overwrites the same value, so at most both calls proceed and dispatch,
// which duplicates Paperclip work in that narrow window. What this
// implementation *does* guarantee: within a single logical call (no
// concurrent duplicate delivery racing it), the check is as tight as the SDK
// allows — the get/set pair is kept minimal (no extra round trips or awaits
// in between) so the race window is as small as it can be made without a
// server-side CAS. Closing this fully requires either an SDK-level
// conditional-write primitive or an external lock and is out of scope for
// this fix; flagged here explicitly rather than claimed as solved.

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
  // Minimize the race window described above: issue the write immediately
  // after the read with no intervening awaits/work, so nothing else in this
  // process can interleave between them. This does not make the pair atomic
  // across concurrent requests/processes (the SDK has no CAS), but it
  // removes any avoidable widening of the window within this function.
  const existing = await state.get(key);
  if (existing) {
    return false;
  }
  await state.set(key, true);
  return true;
}
