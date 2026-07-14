import { describe, it, expect, vi } from "vitest";
import { shouldProcessSlackEvent } from "../../../src/providers/slack/ingress/dedup.js";

function makeState() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: { scopeKind: string; scopeId: string; stateKey: string }) => {
      return store.get(`${key.scopeKind}:${key.scopeId}:${key.stateKey}`) ?? null;
    }),
    set: vi.fn(async (key: { scopeKind: string; scopeId: string; stateKey: string }, value: unknown) => {
      store.set(`${key.scopeKind}:${key.scopeId}:${key.stateKey}`, value);
    }),
    delete: vi.fn(async () => {}),
  };
}

describe("shouldProcessSlackEvent", () => {
  it("processes an event ID that has not been seen before", async () => {
    const state = makeState();
    const result = await shouldProcessSlackEvent(state, "agent-1", "Ev0123ABC");
    expect(result).toBe(true);
  });

  it("does not reprocess an event ID that was already recorded (Slack retry)", async () => {
    const state = makeState();
    await shouldProcessSlackEvent(state, "agent-1", "Ev0123ABC");
    const result = await shouldProcessSlackEvent(state, "agent-1", "Ev0123ABC");
    expect(result).toBe(false);
  });

  it("scopes deduplication per agent — the same event id for a different agent is independent", async () => {
    const state = makeState();
    await shouldProcessSlackEvent(state, "agent-1", "Ev0123ABC");
    const result = await shouldProcessSlackEvent(state, "agent-2", "Ev0123ABC");
    expect(result).toBe(true);
  });

  it("treats distinct event IDs independently", async () => {
    const state = makeState();
    await shouldProcessSlackEvent(state, "agent-1", "Ev0001");
    const result = await shouldProcessSlackEvent(state, "agent-1", "Ev0002");
    expect(result).toBe(true);
  });

  it("records the event id after allowing processing (subsequent duplicate call is rejected)", async () => {
    const state = makeState();
    await shouldProcessSlackEvent(state, "agent-1", "Ev0123ABC");
    expect(state.set).toHaveBeenCalledTimes(1);
  });

  // Documents the residual concurrency caveat called out in dedup.ts: the SDK
  // (`@paperclipai/plugin-sdk` PluginStateClient) exposes only get/set/delete,
  // no compare-and-set. This test asserts the *intended*, achievable
  // behavior — sequential calls are fully deduplicated — while making
  // explicit (via this comment, mirroring the one in dedup.ts) that two
  // truly concurrent deliveries of the same event_id that both call get()
  // before either set() lands could both observe "not seen" and both
  // proceed. That race is a known SDK limitation, not something this
  // function can close on its own, and is not exercised here because doing
  // so would require faking a race in the state client rather than testing
  // this module's real behavior.
  it("fully deduplicates sequential (non-concurrent) calls, which is the guarantee this SDK allows", async () => {
    const state = makeState();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await shouldProcessSlackEvent(state, "agent-1", "Ev-seq"));
    }
    expect(results).toEqual([true, false, false, false, false]);
  });
});
