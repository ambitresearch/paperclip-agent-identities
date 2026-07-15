import { describe, expect, it, vi } from "vitest";
import {
  SLACK_EVENT_DEDUP_MAX_ENTRIES,
  SLACK_EVENT_DEDUP_TTL_MS,
  completeSlackEventClaim,
  releaseSlackEventClaim,
  shouldProcessSlackEvent,
} from "../../../src/providers/slack/ingress/dedup.js";

type StateKey = { scopeKind: string; scopeId: string; namespace?: string; stateKey: string };

function mapKey(key: StateKey): string {
  return `${key.scopeKind}:${key.scopeId}:${key.namespace ?? ""}:${key.stateKey}`;
}

function makeState(store = new Map<string, unknown>()) {
  return {
    store,
    get: vi.fn(async (key: StateKey) => store.get(mapKey(key)) ?? null),
    set: vi.fn(async (key: StateKey, value: unknown) => {
      store.set(mapKey(key), value);
    }),
    delete: vi.fn(async (key: StateKey) => {
      store.delete(mapKey(key));
    }),
  };
}

async function processEvent(
  state: ReturnType<typeof makeState>,
  agentId: string,
  eventId: string,
  nowMs?: number,
): Promise<boolean> {
  const result = await shouldProcessSlackEvent(state, agentId, eventId, nowMs);
  if (result) await completeSlackEventClaim(state, agentId, eventId);
  return result;
}

describe("Slack ingress deduplication", () => {
  it("allows the first delivery and rejects a completed retry", async () => {
    const state = makeState();

    expect(await processEvent(state, "agent-1", "Ev0123ABC")).toBe(true);
    expect(await processEvent(state, "agent-1", "Ev0123ABC")).toBe(false);
  });

  it("scopes event IDs per agent", async () => {
    const state = makeState();

    expect(await processEvent(state, "agent-1", "Ev-shared")).toBe(true);
    expect(await processEvent(state, "agent-2", "Ev-shared")).toBe(true);
  });

  it("treats distinct event IDs independently", async () => {
    const state = makeState();

    expect(await processEvent(state, "agent-1", "Ev0001")).toBe(true);
    expect(await processEvent(state, "agent-1", "Ev0002")).toBe(true);
  });

  it("makes an in-process duplicate await the winning processing outcome", async () => {
    const state = makeState();
    const winner = await shouldProcessSlackEvent(state, "agent-1", "Ev-race");
    expect(winner).toBe(true);

    let duplicateSettled = false;
    const duplicate = shouldProcessSlackEvent(state, "agent-1", "Ev-race").finally(() => {
      duplicateSettled = true;
    });
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);

    await completeSlackEventClaim(state, "agent-1", "Ev-race");
    await expect(duplicate).resolves.toBe(false);
    expect(state.set).toHaveBeenCalledTimes(1);
  });

  it("shares a winning processing failure with an in-process duplicate", async () => {
    const state = makeState();
    const failure = new Error("agent invoke failed");
    expect(await shouldProcessSlackEvent(state, "agent-1", "Ev-fail-race")).toBe(true);

    const duplicate = shouldProcessSlackEvent(state, "agent-1", "Ev-fail-race");
    await releaseSlackEventClaim(state, "agent-1", "Ev-fail-race", failure);

    await expect(duplicate).rejects.toBe(failure);
    expect(await processEvent(state, "agent-1", "Ev-fail-race")).toBe(true);
  });

  it("releases only the failed agent's claim so a later delivery can retry", async () => {
    const state = makeState();
    expect(await shouldProcessSlackEvent(state, "agent-1", "Ev-fail")).toBe(true);
    expect(await processEvent(state, "agent-2", "Ev-fail")).toBe(true);

    await releaseSlackEventClaim(state, "agent-1", "Ev-fail");

    expect(await processEvent(state, "agent-1", "Ev-fail")).toBe(true);
    expect(await processEvent(state, "agent-2", "Ev-fail")).toBe(false);
  });

  it("treats release of a missing claim as a no-op", async () => {
    const state = makeState();

    await expect(releaseSlackEventClaim(state, "agent-1", "Ev-never-seen")).resolves.toBeUndefined();
    expect(await processEvent(state, "agent-1", "Ev-never-seen")).toBe(true);
  });

  it("expires completed event IDs after the Slack retry horizon", async () => {
    const state = makeState();
    expect(await processEvent(state, "agent-1", "Ev-expiring", 1_000)).toBe(true);

    expect(await processEvent(state, "agent-1", "Ev-expiring", 1_000 + SLACK_EVENT_DEDUP_TTL_MS - 1)).toBe(false);
    expect(await processEvent(state, "agent-1", "Ev-expiring", 1_000 + SLACK_EVENT_DEDUP_TTL_MS)).toBe(true);
  });

  it("keeps one bounded persistent ledger per agent", async () => {
    const state = makeState();

    for (let index = 0; index <= SLACK_EVENT_DEDUP_MAX_ENTRIES; index += 1) {
      expect(await processEvent(state, "agent-1", `Ev-${index}`, index)).toBe(true);
    }

    expect(state.store).toHaveLength(1);
    const ledger = [...state.store.values()][0] as { entries: unknown[] };
    expect(ledger.entries).toHaveLength(SLACK_EVENT_DEDUP_MAX_ENTRIES);
  });

  it("hashes untrusted Slack event IDs before using persistent state", async () => {
    const state = makeState();
    const eventId = "Ev-sensitive/raw?identifier";

    expect(await processEvent(state, "agent-1", eventId)).toBe(true);

    const serializedState = JSON.stringify([...state.store.entries()]);
    expect(serializedState).not.toContain(eventId);
    const ledger = [...state.store.values()][0] as { entries: Array<{ eventHash: string }> };
    expect(ledger.entries[0].eventHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not let a stale owner release a newer token for the same event", async () => {
    const state = makeState();
    expect(await shouldProcessSlackEvent(state, "agent-1", "Ev-replaced", 1_000)).toBe(true);

    const [ledgerKey, rawLedger] = [...state.store.entries()][0] as [
      string,
      { version: number; entries: Array<{ eventHash: string; token: string; expiresAt: number }> },
    ];
    const newerToken = "newer-worker-token";
    state.store.set(ledgerKey, {
      ...rawLedger,
      entries: rawLedger.entries.map((entry) => ({ ...entry, token: newerToken })),
    });

    await releaseSlackEventClaim(state, "agent-1", "Ev-replaced", new Error("stale worker failed"));

    const retainedLedger = state.store.get(ledgerKey) as { entries: Array<{ token: string }> };
    expect(retainedLedger.entries[0].token).toBe(newerToken);
  });

  it("uses a unique-token write/read-back check to elect one winner when two state clients overlap before confirmation", async () => {
    // This models the strongest overlap the SDK's get/set/delete API can
    // detect: both workers read an absent event, both writes land, then both
    // confirm ownership. It is intentionally not described as atomic CAS;
    // a later write can still race after an earlier worker's confirmation.
    const store = new Map<string, unknown>();
    let writes = 0;
    let releaseWrites!: () => void;
    const writesLanded = new Promise<void>((resolve) => {
      releaseWrites = resolve;
    });
    const client = () => ({
      get: vi.fn(async (key: StateKey) => store.get(mapKey(key)) ?? null),
      set: vi.fn(async (key: StateKey, value: unknown) => {
        store.set(mapKey(key), value);
        writes += 1;
        if (writes === 2) releaseWrites();
        await writesLanded;
      }),
      delete: vi.fn(async (key: StateKey) => {
        store.delete(mapKey(key));
      }),
    });
    const workerA = client();
    const workerB = client();

    const results = await Promise.all([
      shouldProcessSlackEvent(workerA, "agent-1", "Ev-cross-process", 1_000),
      shouldProcessSlackEvent(workerB, "agent-1", "Ev-cross-process", 1_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    if (results[0]) await completeSlackEventClaim(workerA, "agent-1", "Ev-cross-process");
    if (results[1]) await completeSlackEventClaim(workerB, "agent-1", "Ev-cross-process");
  });
});
