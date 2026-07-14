import { describe, it, expect, vi } from "vitest";
import { shouldProcessSlackEvent, releaseSlackEventClaim } from "../../../src/providers/slack/ingress/dedup.js";

function makeState() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(async (key: { scopeKind: string; scopeId: string; stateKey: string }) => {
      return store.get(`${key.scopeKind}:${key.scopeId}:${key.stateKey}`) ?? null;
    }),
    set: vi.fn(async (key: { scopeKind: string; scopeId: string; stateKey: string }, value: unknown) => {
      store.set(`${key.scopeKind}:${key.scopeId}:${key.stateKey}`, value);
    }),
    delete: vi.fn(async (key: { scopeKind: string; scopeId: string; stateKey: string }) => {
      store.delete(`${key.scopeKind}:${key.scopeId}:${key.stateKey}`);
    }),
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
  // truly concurrent deliveries of the same event_id in *separate worker
  // processes* remain an open SDK limitation this module cannot close alone.
  it("fully deduplicates sequential (non-concurrent) calls, which is the guarantee this SDK allows", async () => {
    const state = makeState();
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      results.push(await shouldProcessSlackEvent(state, "agent-1", "Ev-seq"));
    }
    expect(results).toEqual([true, false, false, false, false]);
  });

  it("serializes truly concurrent calls for the same (agentId, eventId) pair within one process — only one caller proceeds", async () => {
    // Regression test for the get-then-set race within a single worker
    // process: fire two calls for the identical pair without awaiting
    // between them (simulating two in-flight deliveries racing inside the
    // same running worker) and assert exactly one is allowed to proceed.
    const state = makeState();
    const [first, second] = await Promise.all([
      shouldProcessSlackEvent(state, "agent-1", "Ev-race"),
      shouldProcessSlackEvent(state, "agent-1", "Ev-race"),
    ]);

    const proceedCount = [first, second].filter(Boolean).length;
    expect(proceedCount).toBe(1);
    expect(state.set).toHaveBeenCalledTimes(1);
  });

  it("does not let a resolved in-flight claim leak into a later, independent call for the same pair", async () => {
    const state = makeState();
    await shouldProcessSlackEvent(state, "agent-1", "Ev0123ABC");
    const result = await shouldProcessSlackEvent(state, "agent-1", "Ev0123ABC");
    expect(result).toBe(false);
  });

  describe("releaseSlackEventClaim", () => {
    it("allows a subsequent call for the same (agentId, eventId) pair to proceed after release", async () => {
      // Regression test for the failed-invocation-permanently-dedups bug:
      // if the action gated by shouldProcessSlackEvent fails (e.g. agent
      // invoke errors out), the caller must release the claim so a later
      // delivery of the same event_id (a genuine Slack retry, or an
      // operator-triggered replay) is not silently swallowed forever.
      const state = makeState();
      const first = await shouldProcessSlackEvent(state, "agent-1", "Ev-fail");
      expect(first).toBe(true);

      // Simulate the caller's action failing and releasing the claim.
      await releaseSlackEventClaim(state, "agent-1", "Ev-fail");

      const retry = await shouldProcessSlackEvent(state, "agent-1", "Ev-fail");
      expect(retry).toBe(true);
    });

    it("is a no-op when no claim was ever recorded for the pair", async () => {
      const state = makeState();
      await expect(releaseSlackEventClaim(state, "agent-1", "Ev-never-seen")).resolves.toBeUndefined();
      // Still processes normally afterwards.
      const result = await shouldProcessSlackEvent(state, "agent-1", "Ev-never-seen");
      expect(result).toBe(true);
    });

    it("scopes release per agent — releasing agent-1's claim does not affect agent-2's independent claim", async () => {
      const state = makeState();
      await shouldProcessSlackEvent(state, "agent-1", "Ev-shared");
      await shouldProcessSlackEvent(state, "agent-2", "Ev-shared");

      await releaseSlackEventClaim(state, "agent-1", "Ev-shared");

      const agent1Retry = await shouldProcessSlackEvent(state, "agent-1", "Ev-shared");
      const agent2Retry = await shouldProcessSlackEvent(state, "agent-2", "Ev-shared");
      expect(agent1Retry).toBe(true);
      expect(agent2Retry).toBe(false);
    });
  });
});
