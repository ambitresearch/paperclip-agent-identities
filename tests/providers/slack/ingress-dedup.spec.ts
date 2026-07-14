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
});
