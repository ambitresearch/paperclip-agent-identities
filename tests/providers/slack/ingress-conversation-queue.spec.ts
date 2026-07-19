import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueSlackConversationTurn,
  getSlackConversationQueueSummary,
  isRetryableSlackQueueError,
  readSlackConversationState,
  SLACK_COMPLETED_EVENT_RETENTION_MS,
  SLACK_CONVERSATION_STATE_VERSION,
  SLACK_EVENT_CLAIM_LIMIT,
  SLACK_PENDING_TURN_LIMIT,
  SlackConversationQueueFullError,
  slackConversationKey,
  slackEventHash,
  shouldKickSlackConversationQueue,
  type SlackConversationTarget,
} from "../../../src/providers/slack/ingress/conversation-session.js";

type StateKey = { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string };

function mapKey(key: StateKey): string {
  return `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`;
}

function makeState(store = new Map<string, unknown>()) {
  return {
    store,
    get: vi.fn(async (key: StateKey) => store.get(mapKey(key)) ?? null),
    set: vi.fn(async (key: StateKey, value: unknown) => {
      store.set(mapKey(key), structuredClone(value));
    }),
    delete: vi.fn(async (key: StateKey) => {
      store.delete(mapKey(key));
    }),
  };
}

const conversation: SlackConversationTarget = {
  teamId: "T111",
  appId: "A111",
  channel: "D111",
};

function enqueue(
  state: ReturnType<typeof makeState>,
  eventId: string,
  nowMs = 1_000,
) {
  return enqueueSlackConversationTurn({
    state: state as never,
    agentId: "agent-1",
    companyId: "co-1",
    conversation,
    eventId,
    event: { type: "message", channel: "D111", channelType: "im", text: eventId, user: "U222", ts: "1719000000.123456" },
    startMode: "direct",
    nowMs,
  });
}

describe("Slack durable conversation queue", () => {
  it("uses the version-2 durable conversation record", () => {
    expect(SLACK_CONVERSATION_STATE_VERSION).toBe(2);
  });

  it("exports deterministic bounded event hashing", () => {
    expect(slackEventHash("Ev-one")).toMatch(/^[a-f0-9]{64}$/);
    expect(slackEventHash("Ev-one")).toBe(slackEventHash("Ev-one"));
    expect(() => slackEventHash(" Ev-one ")).toThrow(/invalid/i);
  });

  it("persists a bounded turn before enqueue resolves and deduplicates it durably", async () => {
    const state = makeState();

    const enqueued = await enqueue(state, "Ev-one");
    expect(enqueued).toEqual(expect.objectContaining({
      status: "enqueued",
    }));
    expect(state.set).toHaveBeenCalled();
    const stored = [...state.store.values()].find((value) =>
      typeof value === "object" && value !== null && "pending" in value) as unknown as {
        pending: Array<{ eventId: string; eventHash: string }>;
      };
    expect(stored.pending).toHaveLength(1);
    expect(stored.pending[0].eventId).toBe("Ev-one");
    expect(stored.pending[0].eventHash).toMatch(/^[a-f0-9]{64}$/);

    await expect(enqueue(state, "Ev-one", 2_000)).resolves.toEqual(expect.objectContaining({ status: "duplicate" }));
    const persistedQueue = [...state.store.values()].find((value) =>
      typeof value === "object" && value !== null && "pending" in value) as typeof stored;
    expect(persistedQueue.pending).toHaveLength(1);
  });

  it("fails retryably when a competing write replaces the just-enqueued claim before confirmation", async () => {
    const state = makeState();
    state.set.mockImplementationOnce(async (key: StateKey, value: unknown) => {
      const written = structuredClone(value) as {
        pending: Array<{ claimId: string; eventId: string; eventHash: string }>;
      };
      written.pending[0] = {
        ...written.pending[0],
        claimId: "00000000-0000-4000-8000-000000000099",
      };
      state.store.set(mapKey(key), written);
    });

    await expect(enqueue(state, "Ev-raced")).rejects.toThrow(/state conflict.*retry/i);
  });

  it("fails retryably before accepting a turn when the pending queue is full", async () => {
    const state = makeState();
    for (let index = 0; index < SLACK_PENDING_TURN_LIMIT; index += 1) {
      await enqueue(state, `Ev-${index}`, index + 1);
    }

    const failure = enqueue(state, "Ev-overflow", 10_000);
    await expect(failure).rejects.toBeInstanceOf(SlackConversationQueueFullError);
    await failure.catch((error) => {
      expect(isRetryableSlackQueueError(error)).toBe(true);
      expect(error.code).toBe("SLACK_QUEUE_FULL");
    });
    const stored = [...state.store.values()].find((value) =>
      typeof value === "object" && value !== null && "pending" in value) as { pending: unknown[] };
    expect(stored.pending).toHaveLength(SLACK_PENDING_TURN_LIMIT);
  });

  it("checks duplicates before queue capacity so retries still re-kick a full queue", async () => {
    const state = makeState();
    for (let index = 0; index < SLACK_PENDING_TURN_LIMIT; index += 1) {
      await enqueue(state, `Ev-${index}`, index + 1);
    }

    await expect(enqueue(state, "Ev-0", 10_000)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate" }),
    );
  });

  it("counts the active turn against the 32-turn conversation bound", async () => {
    const state = makeState();
    for (let index = 0; index < SLACK_PENDING_TURN_LIMIT; index += 1) {
      await enqueue(state, `Ev-${index}`, index + 1);
    }
    const stored = [...state.store.values()].find((value) =>
      typeof value === "object" && value !== null && "pending" in value) as {
        pending: Array<Record<string, unknown>>;
        active?: Record<string, unknown>;
      };
    const turn = stored.pending.shift()!;
    stored.active = {
      phase: "active",
      attemptId: "00000000-0000-4000-8000-000000000001",
      turn,
      startedAt: 1,
      retireAfter: 30 * 60 * 1_000,
    };

    await expect(enqueue(state, "Ev-overflow-active", 10_000)).rejects.toThrow(/queue is full/i);
  });

  it("keeps active hashes indefinitely and prunes completed hashes from completion time after 24 hours", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    const key = {
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    };
    const eventHash = createHash("sha256").update("Ev-active", "utf8").digest("hex");
    state.store.set(mapKey(key), {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId: "co-1",
      conversation,
      owned: true,
      pending: [],
      active: {
        phase: "accepted",
        attemptId: "00000000-0000-4000-8000-000000000001",
        turn: {
          claimId: "00000000-0000-4000-8000-000000000001",
          eventId: "Ev-active",
          eventHash,
          enqueuedAt: 1,
          event: { type: "message", channel: "D111", channelType: "im", user: "U222", text: "active", ts: "1719000000.123456" },
        },
        sessionId: "session-1",
        runId: "run-1",
        acceptedAt: 1,
        retireAfter: 30 * 60 * 1_000,
      },
      completed: [{ eventHash: "b".repeat(64), completedAt: 5_000, claimId: "00000000-0000-4000-8000-000000000002" }],
    });

    await expect(enqueue(state, "Ev-active", 11 * 60 * 1_000)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate" }),
    );

    await readSlackConversationState({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversationKey,
    });
    await enqueue(state, "Ev-prune", 5_001 + SLACK_COMPLETED_EVENT_RETENTION_MS);
    const stored = [...state.store.values()].find((value) =>
      typeof value === "object" && value !== null && "pending" in value) as unknown as {
        active: { turn: { eventHash: string } };
        completed: unknown[];
      };
    expect(stored.active.turn.eventHash).toBe(eventHash);
    expect(stored.completed).toEqual([]);
  });

  it("retains a completed hash until 24 hours after completion, not enqueue time", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    const eventId = "Ev-completed";
    const eventHash = createHash("sha256").update(eventId, "utf8").digest("hex");
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId: "co-1",
      conversation,
      owned: true,
      pending: [],
      completed: [{ eventHash, completedAt: 100_000, claimId: "00000000-0000-4000-8000-000000000002" }],
    });

    await expect(enqueue(state, eventId, 100_000 + SLACK_COMPLETED_EVENT_RETENTION_MS - 1)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate" }),
    );
  });

  it("uses claim-token read-back for completed duplicates too", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    const eventId = "Ev-completed-race";
    const eventHash = createHash("sha256").update(eventId, "utf8").digest("hex");
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId: "co-1",
      conversation,
      owned: true,
      pending: [],
      completed: [{ eventHash, completedAt: 100_000, claimId: "00000000-0000-4000-8000-000000000002" }],
    });

    await expect(enqueue(state, eventId, 200_000)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate" }),
    );
  });

  it("fails closed on persisted turns whose hash does not match their bounded event ID", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId: "co-1",
      conversation,
      owned: true,
      pending: [{
        claimId: "00000000-0000-4000-8000-000000000003",
        eventId: "Ev-tampered",
        eventHash: "a".repeat(64),
        enqueuedAt: 1,
        event: { type: "message", channel: "D111", channelType: "im", user: "U222", text: "tampered", ts: "1719000000.123456" },
      }],
      completed: [],
    });

    await expect(readSlackConversationState({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversationKey,
    })).rejects.toThrow(/queue state is invalid/i);
  });

  it("fails closed on unknown fields in persisted queue records", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId: "co-1",
      conversation,
      owned: true,
      pending: [],
      completed: [],
      unexpected: "unsafe",
    });

    await expect(readSlackConversationState({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversationKey,
    })).rejects.toThrow(/queue state is invalid/i);
  });

  it("migrates an old dedup hash so a v1 accepted run cannot duplicate after minute ten", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    const eventId = "Ev-v1-active";
    const eventHash = createHash("sha256").update(eventId, "utf8").digest("hex");
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: 1,
      sessionId: "session-v1",
      acceptedRun: { runId: "run-v1", retireAfter: 30 * 60 * 1_000 },
    });
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-ingress",
      stateKey: "event-ledger",
    }), {
      version: 1,
      entries: [{ eventHash, token: "old-token", expiresAt: 10 * 60 * 1_000 }],
    });

    await expect(enqueue(state, eventId, 11 * 60 * 1_000)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate" }),
    );
    const stored = state.store.get(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    })) as { version: number; pending: unknown[]; completed: unknown[]; legacyAcceptedRun: unknown; legacyClaims: unknown[] };
    expect(stored.version).toBe(2);
    expect(stored.pending).toEqual([]);
    expect(stored.completed).toEqual([]);
    expect(stored.legacyClaims).toHaveLength(1);
    expect(stored.legacyAcceptedRun).toBeDefined();
  });

  it("conservatively claims a v1 accepted run with no old ledger instead of risking a resend", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: 1,
      sessionId: "session-v1",
      acceptedRun: { runId: "run-v1", retireAfter: 30 * 60 * 1_000 },
    });

    await expect(enqueue(state, "Ev-unknown-v1", 11 * 60 * 1_000)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate" }),
    );
  });

  it("migrates old dedup hashes to 24-hour completions for a v1 idle session", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    const eventId = "Ev-v1-idle";
    const eventHash = createHash("sha256").update(eventId, "utf8").digest("hex");
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), { version: 1, sessionId: "session-v1" });
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-ingress",
      stateKey: "event-ledger",
    }), {
      version: 1,
      entries: [{ eventHash, token: "old-token", expiresAt: 10 * 60 * 1_000 }],
    });

    await expect(enqueue(state, eventId, 11 * 60 * 1_000)).resolves.toEqual(
      expect.objectContaining({ status: "duplicate" }),
    );
    const stored = state.store.get(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    })) as { completed: unknown[]; legacyClaims?: unknown[] };
    expect(stored.completed).toHaveLength(1);
    expect(stored.legacyClaims).toBeUndefined();
  });

  it("fails closed for a plain reply in a conversation the agent does not own", async () => {
    const state = makeState();
    const threadConversation = { ...conversation, channel: "C111", threadTs: "1719000000.123456" };
    const result = await enqueueSlackConversationTurn({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversation: threadConversation,
      eventId: "Ev-unowned",
      event: {
        type: "message",
        channel: "C111",
        channelType: "channel",
        user: "U222",
        text: "reply",
        ts: "1719000001.123456",
        threadTs: "1719000000.123456",
      },
      startMode: "owned-reply",
      nowMs: 1_000,
    });

    expect(result.status).toBe("ignored");
    const stored = [...state.store.values()].find((value) =>
      typeof value === "object" && value !== null && "pending" in value) as {
        owned: boolean;
        pending: unknown[];
        completed: unknown[];
      };
    expect(stored.owned).toBe(false);
    expect(stored.pending).toEqual([]);
    expect(stored.completed).toHaveLength(1);
  });

  it("rejects inconsistent start-mode and conversation projections before persistence", async () => {
    const state = makeState();
    await expect(enqueueSlackConversationTurn({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversation,
      eventId: "Ev-invalid-mode",
      event: { type: "message", channel: "D111", channelType: "im", user: "U222", text: "invalid", ts: "1719000000.123456" },
      startMode: "mention",
    })).rejects.toThrow(/non-direct turn/i);
    expect(state.set).not.toHaveBeenCalled();
  });

  it("rejects oversized event IDs rather than persisting a lossy dedup key", async () => {
    const state = makeState();
    await expect(enqueue(state, `Ev-${"x".repeat(200)}`)).rejects.toThrow(/event ID is invalid/i);
    expect(state.set).not.toHaveBeenCalled();
  });

  it("returns a secret-free operational queue summary", async () => {
    const state = makeState();
    const queued = await enqueue(state, "Ev-summary");
    const summary = await getSlackConversationQueueSummary({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversationKey: queued.conversationKey,
    });

    expect(summary).toEqual({
      version: SLACK_CONVERSATION_STATE_VERSION,
      status: "queued",
      pendingCount: 1,
      hasSession: false,
      completedCount: 0,
      atCapacity: false,
    });
    expect(JSON.stringify(summary)).not.toContain("Ev-summary");
    await expect(shouldKickSlackConversationQueue({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversationKey: queued.conversationKey,
    })).resolves.toBe(true);
  });

  it("does not recommend a kick while an accepted run blocks the queue", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    const eventId = "Ev-active-summary";
    const eventHash = createHash("sha256").update(eventId, "utf8").digest("hex");
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId: "co-1",
      conversation,
      owned: true,
      sessionId: "session-1",
      pending: [],
      active: {
        phase: "accepted",
        attemptId: "00000000-0000-4000-8000-000000000001",
        turn: {
          claimId: "00000000-0000-4000-8000-000000000002",
          eventId,
          eventHash,
          enqueuedAt: 1,
          event: {
            type: "message",
            channel: "D111",
            channelType: "im",
            text: "active",
            user: "U222",
            ts: "1719000000.123456",
          },
        },
        sessionId: "session-1",
        runId: "run-1",
        acceptedAt: 2,
        retireAfter: 30 * 60 * 1_000,
      },
      completed: [],
    });

    await expect(shouldKickSlackConversationQueue({
      state: state as never,
      agentId: "agent-1",
      companyId: "co-1",
      conversationKey,
    })).resolves.toBe(false);
  });

  it("prunes stale completed claims before enforcing the ledger cap", async () => {
    const state = makeState();
    const conversationKey = slackConversationKey(conversation);
    state.store.set(mapKey({
      scopeKind: "agent",
      scopeId: "agent-1",
      namespace: "slack-conversations",
      stateKey: `session:${conversationKey}`,
    }), {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId: "co-1",
      conversation,
      owned: true,
      pending: [],
      completed: Array.from({ length: SLACK_EVENT_CLAIM_LIMIT }, (_, index) => ({
        eventHash: index.toString(16).padStart(64, "0"),
        completedAt: 1,
        claimId: `legacy:${index.toString(16).padStart(32, "0")}`,
      })),
    });

    await expect(enqueue(state, "Ev-after-prune", SLACK_COMPLETED_EVENT_RETENTION_MS + 2)).resolves.toEqual(
      expect.objectContaining({ status: "enqueued" }),
    );
  });
});
