import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  contributeSlackIngress,
  classifySlackSendFailure,
  createSlackTurnDrainPayload,
  drainSlackConversationQueue,
  handleSlackProviderWebhook,
  SLACK_ACCEPTED_RUN_LEASE_MS,
  SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
  SLACK_TURN_DRAIN_EVENT_TYPE,
  slackWebhookDeclarations,
  type SlackAgentReply,
  type SlackAgentReplyStreamTarget,
  type SlackTurnDrainPayload,
} from "../../../src/providers/slack/ingress/provider-webhook.js";
import {
  SLACK_COMPLETED_EVENT_RETENTION_MS,
  slackConversationKey,
  type SlackConversationTarget,
} from "../../../src/providers/slack/ingress/conversation-session.js";
import { resetSlackRateLimitState } from "../../../src/providers/slack/ingress/rate-limit.js";

const SIGNING_SECRET = "provider-webhook-signing-secret";
const SIGNING_SECRET_ID = "00000000-0000-4000-8000-000000000001";
const BOT_TOKEN_SECRET_ID = "00000000-0000-4000-8000-000000000002";
const BOT_TOKEN = "xoxb-test";

const COMPANY_CONFIG = {
  identities: {
    "agent-1": {
      slack: {
        label: "Agent 1",
        teamId: "T111",
        appId: "A111",
        botUserId: "U111",
        credentials: {
          botToken: { type: "secret_ref", secretId: BOT_TOKEN_SECRET_ID, version: "latest" },
          signingSecret: { type: "secret_ref", secretId: SIGNING_SECRET_ID, version: "latest" },
        },
      },
    },
  },
} as const;

type StateKey = { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string };

function mapKey(key: StateKey): string {
  return `${key.scopeKind}:${key.scopeId ?? ""}:${key.namespace ?? ""}:${key.stateKey}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sign(timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`, "utf8")
    .digest("hex")}`;
}

function delivery(eventId: string, text = eventId, overrides: Record<string, unknown> = {}) {
  const event = {
    type: "message",
    channel_type: "im",
    channel: "D111",
    user: "U222",
    text,
    ts: `1719000000.${eventId.replace(/\D/g, "").padStart(6, "0").slice(-6)}`,
    ...overrides,
  };
  const rawBody = JSON.stringify({
    type: "event_callback",
    team_id: "T111",
    api_app_id: "A111",
    event_id: eventId,
    authorizations: [{ team_id: "T111" }],
    event,
  });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  return {
    endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
    companyId: "co-1",
    headers: {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": sign(timestamp, rawBody),
    },
    rawBody,
    requestId: `req-${eventId}`,
  };
}

function makeCtx(options: {
  emit?: (name: string, companyId: string, payload: unknown) => Promise<void>;
  sendMessage?: (
    sessionId: string,
    companyId: string,
    options: { prompt: string; reason?: string; onEvent?: (event: AgentSessionEvent) => void },
  ) => Promise<{ runId: string }>;
  close?: (sessionId: string, companyId: string) => Promise<void>;
  store?: Map<string, unknown>;
} = {}) {
  const store = options.store ?? new Map<string, unknown>();
  const eventHandlers = new Map<string, (event: PluginEvent) => Promise<void>>();
  const activeSessions = new Map<string, {
    sessionId: string;
    agentId: string;
    companyId: string;
    status: "active";
    createdAt: string;
  }>();
  let sessionNumber = 0;
  let runNumber = 0;
  const emitted: Array<{ name: string; companyId: string; payload: SlackTurnDrainPayload }> = [];
  const emit = vi.fn(options.emit ?? (async (name: string, companyId: string, payload: unknown) => {
    emitted.push({ name, companyId, payload: payload as SlackTurnDrainPayload });
  }));
  const sendMessage = vi.fn(options.sendMessage ?? (async (
    sessionId: string,
    _companyId: string,
    sendOptions: { onEvent?: (event: AgentSessionEvent) => void },
  ) => {
    const runId = `run-${++runNumber}`;
    queueMicrotask(() => sendOptions.onEvent?.({
      sessionId,
      runId,
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    }));
    return { runId };
  }));
  const close = vi.fn(options.close ?? (async (sessionId: string) => {
    activeSessions.delete(sessionId);
  }));

  const ctx = {
    manifest: { id: "ambitresearch.paperclip-agent-identities" },
    config: { get: vi.fn(async () => structuredClone(COMPANY_CONFIG)) },
    state: {
      get: vi.fn(async (key: StateKey) => store.get(mapKey(key)) ?? null),
      set: vi.fn(async (key: StateKey, value: unknown) => {
        store.set(mapKey(key), structuredClone(value));
      }),
      delete: vi.fn(async (key: StateKey) => {
        store.delete(mapKey(key));
      }),
    },
    secrets: {
      resolve: vi.fn(async (ref: { secretId: string }) =>
        ref.secretId === SIGNING_SECRET_ID ? SIGNING_SECRET : BOT_TOKEN),
    },
    http: {
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "https://slack.com/api/auth.test") {
          return new Response(JSON.stringify({
            ok: true,
            team_id: "T111",
            user_id: "U111",
            bot_id: "B111",
          }), { status: 200 });
        }
        if (url === "https://slack.com/api/users.info") {
          const user = new URLSearchParams(String(init?.body)).get("user");
          return new Response(JSON.stringify({
            ok: true,
            user: {
              id: user,
              team_id: "T111",
              real_name: "Roshan Gautam",
              profile: { display_name: "Roshan", email: "private@example.com" },
            },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false, error: "unexpected" }), { status: 404 });
      }),
    },
    agents: {
      list: vi.fn(async () => []),
      get: vi.fn(async (agentId: string, companyId: string) => ({ id: agentId, companyId })),
      sessions: {
        create: vi.fn(async (agentId: string, companyId: string) => {
          const session = {
            sessionId: `session-${++sessionNumber}`,
            agentId,
            companyId,
            status: "active" as const,
            createdAt: "2026-07-18T00:00:00.000Z",
          };
          activeSessions.set(session.sessionId, session);
          return session;
        }),
        list: vi.fn(async (agentId: string, companyId: string) =>
          [...activeSessions.values()].filter(
            (session) => session.agentId === agentId && session.companyId === companyId,
          )),
        sendMessage,
        close,
      },
    },
    events: {
      on: vi.fn((name: string, handler: (event: PluginEvent) => Promise<void>) => {
        eventHandlers.set(name, handler);
        return () => eventHandlers.delete(name);
      }),
      emit,
    },
    activity: { log: vi.fn(async () => undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  return { ctx, store, emitted, eventHandlers, activeSessions, sendMessage, close };
}

function queueState(store: Map<string, unknown>) {
  return [...store.entries()].find(([key]) => key.includes("slack-conversations"))?.[1] as {
    pending: Array<{ eventId: string }>;
    active?: { phase: string; turn: { eventId: string }; runId?: string; retireAfter?: number };
    completed: Array<{ eventHash: string; completedAt: number }>;
    sessionId?: string;
  };
}

function runtime(
  postReply: (reply: SlackAgentReply) => Promise<unknown> = async () => undefined,
  createReplyStream?: (target: SlackAgentReplyStreamTarget) => {
    start(): Promise<void>;
    append(text: string): Promise<void>;
    finish(text: string): Promise<boolean>;
    fail(): Promise<void>;
  },
) {
  return { postReply, createReplyStream, acceptedRunLeaseMs: 30 * 60 * 1_000 };
}

describe("Slack provider durable ingress", () => {
  beforeEach(() => {
    resetSlackRateLimitState();
  });

  it("classifies only the host's exact missing-session response as safely retryable", () => {
    expect(classifySlackSendFailure(new Error("Session not found: session-1"))).toBe("definitive-missing-session");
    expect(classifySlackSendFailure(new Error("Session not found or closed: session-1"))).toBe("definitive-missing-session");
    expect(classifySlackSendFailure(new Error("agent runtime unavailable"))).toBe("ambiguous");
  });

  it("exports a strict immutable drain payload helper", () => {
    const payload = createSlackTurnDrainPayload("agent-1", "a".repeat(64));
    expect(payload).toEqual({ agentId: "agent-1", conversationKey: "a".repeat(64) });
    expect(() => createSlackTurnDrainPayload("agent-1", "bad")).toThrow(/invalid/i);
  });

  it("declares one endpoint and persists before awaiting the self-kick without sending in webhook scope", async () => {
    expect(slackWebhookDeclarations).toHaveLength(1);
    const kick = deferred<void>();
    const { ctx, store, sendMessage } = makeCtx({ emit: async () => kick.promise });

    let settled = false;
    const response = handleSlackProviderWebhook(delivery("Ev001"), ctx as never).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(ctx.events.emit).toHaveBeenCalledOnce());

    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001"]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.list).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.close).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    kick.resolve();
    await expect(response).resolves.toEqual({ status: 200, body: { ok: true } });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not require a self-kick for ignored thread replies", async () => {
    const kickError = new Error("event bus unavailable");
    const { ctx, store, sendMessage } = makeCtx({ emit: async () => { throw kickError; } });

    await expect(handleSlackProviderWebhook(delivery("Ev999", "orphan", {
      type: "message",
      channel_type: "channel",
      channel: "C111",
      thread_ts: "1719000000.000001",
    }), ctx as never)).resolves.toEqual({ status: 200, body: { ok: true } });

    expect(ctx.events.emit).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queueState(store).pending).toEqual([]);
  });

  it("returns a second same-conversation webhook before the first run terminates", async () => {
    const send = deferred<{ runId: string }>();
    const { ctx, store, sendMessage, close } = makeCtx({
      sendMessage: async () => send.promise,
    });

    await handleSlackProviderWebhook(delivery("Ev001", "first"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    const drain = drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    await expect(handleSlackProviderWebhook(delivery("Ev002", "second"), ctx as never)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev002"]);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    send.resolve({ runId: "run-1" });
    await drain;
  });

  it("serializes concurrent same-conversation webhook enqueues in arrival order", async () => {
    const { ctx, store } = makeCtx();
    await Promise.all([
      handleSlackProviderWebhook(delivery("Ev001", "first"), ctx as never),
      handleSlackProviderWebhook(delivery("Ev002", "second"), ctx as never),
    ]);

    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001", "Ev002"]);
  });

  it("concurrent duplicate webhooks persist one turn and both re-kick promptly", async () => {
    const { ctx, store } = makeCtx();
    await Promise.all([
      handleSlackProviderWebhook(delivery("Ev001"), ctx as never),
      handleSlackProviderWebhook(delivery("Ev001"), ctx as never),
    ]);

    expect(queueState(store).pending).toHaveLength(1);
    expect(ctx.events.emit).toHaveBeenCalledTimes(2);
  });

  it("drains one turn under the self-event and starts its successor once, in FIFO order, after reply finalization", async () => {
    const callbacks: Array<(event: AgentSessionEvent) => void | Promise<void>> = [];
    const { ctx, store, sendMessage, close } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callbacks.push(options.onEvent!);
        return { runId: `run-${callbacks.length}` };
      },
    });
    const finishGate = deferred<boolean>();
    const streams = [
      {
        start: vi.fn(async () => undefined),
        append: vi.fn(async () => undefined),
        finish: vi.fn(() => finishGate.promise),
        fail: vi.fn(async () => undefined),
      },
      {
        start: vi.fn(async () => undefined),
        append: vi.fn(async () => undefined),
        finish: vi.fn(async () => true),
        fail: vi.fn(async () => undefined),
      },
    ];
    let streamIndex = 0;
    const createReplyStream = vi.fn(() => streams[streamIndex++]);

    await handleSlackProviderWebhook(delivery("Ev001", "first"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev002", "second"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime(async () => undefined, createReplyStream));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(createReplyStream).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "agent-1",
      companyId: "co-1",
      eventId: "Ev001",
      channel: "D111",
    }));
    expect(sendMessage.mock.calls[0][2].prompt).toContain('"text":"first"');
    await callbacks[0]({
      sessionId: "session-1",
      runId: "run-1",
      seq: 1,
      eventType: "chunk",
      stream: "stdout",
      message: '{"type":"result","result":"first reply"}\n',
      payload: null,
    });
    const terminal = callbacks[0]({
      sessionId: "session-1",
      runId: "run-1",
      seq: 2,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    await vi.waitFor(() => expect(streams[0].finish).toHaveBeenCalledWith("first reply"));
    expect(queueState(store).active?.turn.eventId).toBe("Ev001");
    expect(ctx.events.emit).toHaveBeenCalledTimes(2);

    finishGate.resolve(true);
    await terminal;
    expect(queueState(store).active).toBeUndefined();
    expect(ctx.events.emit).toHaveBeenCalledTimes(3);
    expect(queueState(store).completed).toHaveLength(1);
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev002"]);

    const successorPayload = ctx.events.emit.mock.calls[2][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(
      ctx as never,
      "co-1",
      successorPayload,
      runtime(async () => undefined, createReplyStream),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][2].prompt).toContain('"text":"second"');
    expect(sendMessage.mock.calls.map(([sessionId]) => sessionId)).toEqual(["session-1", "session-1"]);
  });

  it("keeps a successor durable when its terminal kick fails", async () => {
    let emitCount = 0;
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx, store } = makeCtx({
      emit: async () => {
        emitCount += 1;
        if (emitCount === 3) throw new Error("event bus unavailable");
      },
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-1" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001", "first"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev002", "second"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());

    await callback({
      sessionId: "session-1",
      runId: "run-1",
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    expect(queueState(store).active).toBeUndefined();
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev002"]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Slack ingress: successor kick failed; persisted queue awaits a fresh trigger",
      { agentId: "agent-1" },
    );
  });

  it("re-kicks pending, active, and completed duplicates without enqueuing twice, including beyond ten minutes", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx, store, sendMessage } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-long" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    expect(queueState(store).pending).toHaveLength(1);
    expect(ctx.events.emit).toHaveBeenCalledTimes(2);

    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(queueState(store).active?.phase).toBe("accepted");
    expect(sendMessage).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now + 11 * 60 * 1_000);
    try {
      await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    } finally {
      vi.useRealTimers();
    }
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(queueState(store).pending).toHaveLength(0);

    await callback({
      sessionId: "session-1",
      runId: "run-long",
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    expect(queueState(store).active).toBeUndefined();
    expect(queueState(store).completed).toHaveLength(1);

    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    expect(queueState(store).pending).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("keeps an accepted hash deduplicated beyond its nominal lease until a fresh drain retires it", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, store, sendMessage } = makeCtx({ sendMessage: async () => ({ runId: "run-lease" }) });
      await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
      const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
      await drainSlackConversationQueue(ctx as never, "co-1", payload, {
        ...runtime(),
        acceptedRunLeaseMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
      expect(queueState(store).pending).toHaveLength(0);
      expect(queueState(store).active?.phase).toBe("accepted");
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires an expired accepted lease only from a later fresh event scope, then drains the successor", async () => {
    vi.useFakeTimers();
    try {
      const callbacks: Array<(event: AgentSessionEvent) => void | Promise<void>> = [];
      const { ctx, store, sendMessage, close } = makeCtx({
        sendMessage: async (_sessionId, _companyId, options) => {
          callbacks.push(options.onEvent!);
          return { runId: `run-${callbacks.length}` };
        },
      });
      await handleSlackProviderWebhook(delivery("Ev001", "first"), ctx as never);
      await handleSlackProviderWebhook(delivery("Ev002", "second"), ctx as never);
      const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
      const shortRuntime = { ...runtime(), acceptedRunLeaseMs: 1_000 };
      await drainSlackConversationQueue(ctx as never, "co-1", payload, shortRuntime);

      expect(sendMessage).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_001);
      expect(close).not.toHaveBeenCalled();
      expect(sendMessage).toHaveBeenCalledOnce();

      await drainSlackConversationQueue(ctx as never, "co-1", payload, shortRuntime);
      expect(close).toHaveBeenCalledWith("session-1", "co-1");
      expect(queueState(store).active).toBeUndefined();

      const successorPayload = ctx.events.emit.mock.calls.at(-1)![2] as SlackTurnDrainPayload;
      await drainSlackConversationQueue(ctx as never, "co-1", successorPayload, shortRuntime);
      expect(sendMessage).toHaveBeenCalledTimes(2);

      await callbacks[0]({
        sessionId: "session-1",
        runId: "run-1",
        seq: 1,
        eventType: "done",
        stream: "system",
        message: null,
        payload: null,
      });
      expect(queueState(store).active?.turn.eventId).toBe("Ev002");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requeues an expired pre-send active claim after restart instead of dropping it", async () => {
    vi.useFakeTimers();
    try {
      const store = new Map<string, unknown>();
      const first = makeCtx({ store });
      await handleSlackProviderWebhook(delivery("Ev001"), first.ctx as never);
      const payload = first.ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
      const state = queueState(store);
      const turn = state.pending.shift()! as unknown as Record<string, unknown>;
      state.active = {
        phase: "active",
        attemptId: "00000000-0000-4000-8000-000000000001",
        turn: turn as never,
        startedAt: Date.now(),
        retireAfter: Date.now() + 1_000,
      } as never;

      await vi.advanceTimersByTimeAsync(1_001);
      const restarted = makeCtx({ store, sendMessage: async () => ({ runId: "run-recovered" }) });
      await drainSlackConversationQueue(restarted.ctx as never, "co-1", payload, {
        ...runtime(),
        acceptedRunLeaseMs: 1_000,
      });

      expect(queueState(store).active).toBeUndefined();
      expect(queueState(store).pending.map((queued) => queued.eventId)).toEqual(["Ev001"]);
      expect(restarted.sendMessage).not.toHaveBeenCalled();

      await drainSlackConversationQueue(restarted.ctx as never, "co-1", payload, runtime());
      expect(restarted.sendMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requeues an expired pre-send claim that had only reused a known-active session", async () => {
    vi.useFakeTimers();
    try {
      const { ctx, store, sendMessage } = makeCtx();
      await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
      const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
      const queued = queueState(store).pending.shift()! as unknown as Record<string, unknown>;
      await ctx.agents.sessions.create("agent-1", "co-1");
      const state = queueState(store);
      state.sessionId = "session-1";
      state.active = {
        phase: "active",
        attemptId: "00000000-0000-4000-8000-000000000001",
        turn: queued as never,
        startedAt: Date.now(),
        retireAfter: Date.now() + 1_000,
      } as never;

      await vi.advanceTimersByTimeAsync(1_001);
      await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
      expect(queueState(store).active).toBeUndefined();
      expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001"]);
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires an expired v1 accepted session with no old ledger without sending the duplicate", async () => {
    vi.useFakeTimers();
    try {
      const store = new Map<string, unknown>();
      const conversation = { teamId: "T111", appId: "A111", channel: "D111" };
      const conversationKey = slackConversationKey(conversation);
      store.set(`agent:agent-1:slack-conversations:session:${conversationKey}`, {
        version: 1,
        sessionId: "session-v1",
        acceptedRun: { runId: "run-v1", retireAfter: Date.now() + 1_000 },
      });
      const { ctx, sendMessage, close } = makeCtx({ store });
      await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
      const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

      await vi.advanceTimersByTimeAsync(1_001);
      await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
      expect(close).toHaveBeenCalledWith("session-v1", "co-1");
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the queued turn and rejects retryably when the self-kick fails", async () => {
    const kickError = new Error("event bus unavailable");
    const { ctx, store, sendMessage } = makeCtx({ emit: async () => { throw kickError; } });

    await expect(handleSlackProviderWebhook(delivery("Ev001"), ctx as never)).rejects.toThrow(kickError);
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("logs no raw event ID when enqueue fails", async () => {
    const { ctx } = makeCtx();
    const eventId = `Ev-${"sensitive".repeat(30)}`;
    await expect(handleSlackProviderWebhook(delivery(eventId), ctx as never)).rejects.toThrow();
    expect(JSON.stringify(ctx.logger.error.mock.calls)).not.toContain(eventId);
  });

  it("a webhook retry re-kicks a turn retained by an earlier kick failure", async () => {
    let failKick = true;
    const { ctx, store } = makeCtx({
      emit: async () => {
        if (failKick) throw new Error("event bus unavailable");
      },
    });
    await expect(handleSlackProviderWebhook(delivery("Ev001"), ctx as never)).rejects.toThrow();
    failKick = false;
    await expect(handleSlackProviderWebhook(delivery("Ev001"), ctx as never)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(queueState(store).pending).toHaveLength(1);
    expect(ctx.events.emit).toHaveBeenCalledTimes(2);
  });

  it("fails retryably when pre-send drain setup fails and preserves the turn for a later kick", async () => {
    const { ctx, store, sendMessage } = makeCtx();
    ctx.config.get.mockRejectedValueOnce(new Error("company config unavailable"));
    await handleSlackProviderWebhook(delivery("Ev001"), {
      ...ctx,
      config: { get: vi.fn(async () => structuredClone(COMPANY_CONFIG)) },
    } as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow(
      "company config unavailable",
    );
    expect(queueState(store).active).toBeUndefined();
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send a queued turn after its configured Slack route changes", async () => {
    const { ctx, store, sendMessage } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    ctx.config.get.mockResolvedValueOnce({
      identities: {
        "agent-1": {
          slack: {
            ...COMPANY_CONFIG.identities["agent-1"].slack,
            appId: "A222",
          },
        },
      },
    } as never);

    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow(
      /route changed/i,
    );
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001"]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(ctx.agents.sessions.create).not.toHaveBeenCalled();
  });

  it("a later restored route can drain the still-persisted turn", async () => {
    const { ctx, sendMessage } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    ctx.config.get.mockResolvedValueOnce({ identities: {} } as never);
    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow();

    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not send after the target agent leaves the fresh company scope", async () => {
    const { ctx, store, sendMessage } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    ctx.agents.get.mockResolvedValueOnce(null as never);

    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow(
      /no longer belongs/i,
    );
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send after the Slack identity is removed before drain", async () => {
    const { ctx, store, sendMessage } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    ctx.config.get.mockResolvedValueOnce({ identities: {} } as never);

    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow(
      /No Slack identity configured/i,
    );
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001"]);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("persists the active claim before any session host call", async () => {
    const { ctx, store } = makeCtx();
    const phases: string[] = [];
    ctx.agents.sessions.create.mockImplementationOnce(async (agentId: string, companyId: string) => {
      phases.push(queueState(store).active?.phase ?? "missing");
      return {
        sessionId: "session-observed",
        agentId,
        companyId,
        status: "active" as const,
        createdAt: new Date().toISOString(),
      };
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(phases).toEqual(["active"]);
  });

  it("persists accepted run ownership before drain returns", async () => {
    const { ctx, store } = makeCtx({ sendMessage: async () => ({ runId: "run-accepted" }) });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());

    expect(queueState(store).active).toMatchObject({ phase: "accepted", runId: "run-accepted" });
  });

  it("uses the bounded safe queued projection when constructing the agent prompt", async () => {
    const { ctx, sendMessage } = makeCtx({ sendMessage: async () => ({ runId: "run-safe" }) });
    await handleSlackProviderWebhook(delivery("Ev001", "safe text", {
      arbitrary: "DO_NOT_PROMPT",
    }), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());

    const prompt = sendMessage.mock.calls[0][2].prompt;
    expect(prompt).toContain("safe text");
    expect(prompt).not.toContain("DO_NOT_PROMPT");
  });

  it("coalesces concurrent drain events so one queued turn is sent once", async () => {
    const send = deferred<{ runId: string }>();
    const { ctx, sendMessage } = makeCtx({ sendMessage: async () => send.promise });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    const drains = [
      drainSlackConversationQueue(ctx as never, "co-1", payload, runtime()),
      drainSlackConversationQueue(ctx as never, "co-1", payload, runtime()),
    ];
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    send.resolve({ runId: "run-once" });
    await Promise.all(drains);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("does not serialize drains for different conversations", async () => {
    const firstSend = deferred<{ runId: string }>();
    const { ctx, sendMessage } = makeCtx({
      sendMessage: async (sessionId) => sessionId === "session-1"
        ? firstSend.promise
        : { runId: "run-second" },
    });
    await handleSlackProviderWebhook(delivery("Ev-dm", "dm"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev-thread", "thread", {
      type: "app_mention",
      channel_type: "channel",
      channel: "C111",
      ts: "1719000000.123456",
    }), ctx as never);
    const payloads = ctx.events.emit.mock.calls.map((call) => call[2] as SlackTurnDrainPayload);
    const dmDrain = drainSlackConversationQueue(ctx as never, "co-1", payloads[0], runtime());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
    await drainSlackConversationQueue(ctx as never, "co-1", payloads[1], runtime());
    expect(sendMessage).toHaveBeenCalledTimes(2);

    firstSend.resolve({ runId: "run-first" });
    await dmDrain;
  });

  it("does not serialize webhook acknowledgement behind a conversation drain lock", async () => {
    const send = deferred<{ runId: string }>();
    const { ctx, sendMessage } = makeCtx({ sendMessage: async () => send.promise });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    const drain = drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

    await expect(handleSlackProviderWebhook(delivery("Ev002"), ctx as never)).resolves.toEqual({
      status: 200,
      body: { ok: true },
    });
    send.resolve({ runId: "run-1" });
    await drain;
  });

  it("bounds oversized Slack text before persisting the queued turn", async () => {
    const { ctx, store } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev-large", "x".repeat(10_000)), ctx as never);

    const queued = queueState(store).pending[0] as unknown as { event: { text: string } };
    expect(queued.event.text).toHaveLength(4_096);
  });

  it("truncates at a Unicode-safe boundary before persistence", async () => {
    const { ctx, store } = makeCtx();
    const text = `${"x".repeat(4_095)}👋overflow`;
    await handleSlackProviderWebhook(delivery("Ev-unicode", text), ctx as never);
    const queued = queueState(store).pending[0] as unknown as { event: { text: string } };
    expect(queued.event.text).not.toContain("\ud83d");
    expect(queued.event.text.length).toBeLessThanOrEqual(4_096);
  });

  it("keeps persisted Unicode text within the byte bound", async () => {
    const { ctx, store } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev-byte-bound", "👋".repeat(4_000)), ctx as never);
    const queued = queueState(store).pending[0] as unknown as { event: { text: string } };
    expect(Buffer.byteLength(queued.event.text, "utf8")).toBeLessThanOrEqual(65_536);
  });

  it("persists only the allowlisted Slack event projection", async () => {
    const { ctx, store } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev-projection", "hello", {
      arbitrary: "do-not-persist",
      files: [{ private: true }],
    }), ctx as never);

    const queued = queueState(store).pending[0] as unknown as { event: Record<string, unknown> };
    expect(Object.keys(queued.event).sort()).toEqual(["channel", "channelType", "text", "ts", "type", "user"]);
    expect(JSON.stringify(queued)).not.toContain("do-not-persist");
  });

  it("hashes event IDs while retaining only the bounded Slack ID needed for prompts", async () => {
    const { ctx, store } = makeCtx();
    const eventId = "Ev-sensitive/raw?identifier";
    await handleSlackProviderWebhook(delivery(eventId), ctx as never);
    const serialized = JSON.stringify(queueState(store));
    expect(serialized).toContain(eventId);
    expect(queueState(store).pending[0]).toMatchObject({ eventId, eventHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("keeps different Slack conversations independently drainable", async () => {
    const { ctx, sendMessage } = makeCtx({ sendMessage: async () => ({ runId: "run" }) });
    await handleSlackProviderWebhook(delivery("Ev-dm", "dm"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev-thread", "thread", {
      type: "app_mention",
      channel_type: "channel",
      channel: "C111",
      ts: "1719000000.123456",
    }), ctx as never);
    const payloads = ctx.events.emit.mock.calls.map((call) => call[2] as SlackTurnDrainPayload);
    expect(payloads[0].conversationKey).not.toBe(payloads[1].conversationKey);

    await Promise.all(payloads.map((payload) =>
      drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())));
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("keeps DM top-level and threaded messages in one conversation queue", async () => {
    const { ctx, store } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev001", "top-level"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev002", "threaded", {
      thread_ts: "1719000000.000001",
    }), ctx as never);

    const conversationRecords = [...store.keys()].filter((key) => key.includes("slack-conversations"));
    expect(conversationRecords).toHaveLength(1);
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev001", "Ev002"]);
  });

  it("fails closed for a plain reply in an unowned channel thread", async () => {
    const { ctx, store, sendMessage } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev-unowned", "plain", {
      channel_type: "channel",
      channel: "C111",
      thread_ts: "1719000000.123456",
    }), ctx as never);

    expect(queueState(store).pending).toEqual([]);
    expect(queueState(store).completed).toHaveLength(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("top-level channel broadcasts establish owned thread queues", async () => {
    const { ctx, store } = makeCtx();
    const rootTs = "1719000000.123456";
    await handleSlackProviderWebhook(delivery("Ev-broadcast", "<!channel> status", {
      channel_type: "channel",
      channel: "C111",
      ts: rootTs,
    }), ctx as never);

    const state = queueState(store) as unknown as { owned: boolean; pending: unknown[] };
    expect(state.owned).toBe(true);
    expect(state.pending).toHaveLength(1);
  });

  it("plain top-level channel messages remain filtered before queue state", async () => {
    const { ctx, store } = makeCtx();
    await handleSlackProviderWebhook(delivery("Ev-plain", "ordinary", {
      channel_type: "channel",
      channel: "C111",
    }), ctx as never);
    expect(store.size).toBe(0);
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });

  it("dispatches a plain reply after an app mention establishes thread ownership", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx, sendMessage } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: `run-${sendMessage.mock.calls.length}` };
      },
    });
    const rootTs = "1719000000.123456";
    await handleSlackProviderWebhook(delivery("Ev-root", "root", {
      type: "app_mention",
      channel_type: "channel",
      channel: "C111",
      ts: rootTs,
    }), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await callback({
      sessionId: "session-1",
      runId: "run-1",
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });

    await handleSlackProviderWebhook(delivery("Ev-reply", "reply", {
      channel_type: "channel",
      channel: "C111",
      thread_ts: rootTs,
    }), ctx as never);
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not let a throwing logger block terminal completion or the successor kick", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx, store } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-logger" };
      },
    });
    ctx.logger.warn.mockImplementation(() => { throw new Error("logger unavailable"); });
    ctx.logger.error.mockImplementation(() => { throw new Error("logger unavailable"); });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev002"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());

    await callback({
      sessionId: "session-1",
      runId: "run-logger",
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    expect(queueState(store).active).toBeUndefined();
    expect(ctx.events.emit).toHaveBeenCalledTimes(3);
  });

  it("waits for fallback reply finalization before clearing active state", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const postGate = deferred<unknown>();
    const { ctx, store } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-post-gate" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime(() => postGate.promise));

    await callback({
      sessionId: "session-1",
      runId: "run-post-gate",
      seq: 1,
      eventType: "chunk",
      stream: "stdout",
      message: "reply",
      payload: null,
    });
    const terminal = callback({
      sessionId: "session-1",
      runId: "run-post-gate",
      seq: 2,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    await Promise.resolve();
    expect(queueState(store).active?.phase).toBe("accepted");

    postGate.resolve(undefined);
    await terminal;
    expect(queueState(store).active).toBeUndefined();
  });

  it("ignores late callbacks after successful terminal completion", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const postReply = vi.fn(async () => undefined);
    const { ctx } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-complete" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime(postReply));
    await callback({
      sessionId: "session-1",
      runId: "run-complete",
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    await callback({
      sessionId: "session-1",
      runId: "run-complete",
      seq: 2,
      eventType: "chunk",
      stream: "stdout",
      message: "late",
      payload: null,
    });
    expect(postReply).not.toHaveBeenCalled();
  });

  it("retires a session after a terminal run error before starting a successor", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx, store, close } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-error" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await callback({
      sessionId: "session-1",
      runId: "run-error",
      seq: 1,
      eventType: "error",
      stream: "system",
      message: "agent failed",
      payload: null,
    });

    expect(close).toHaveBeenCalledWith("session-1", "co-1");
    expect(queueState(store).sessionId).toBeUndefined();
    expect(queueState(store).completed).toHaveLength(1);
  });

  it("keeps failed-session retirement pending without starting the successor", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const closeError = new Error("close unavailable");
    const { ctx, store, sendMessage } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-error" };
      },
      close: async () => { throw closeError; },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev002"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await callback({
      sessionId: "session-1",
      runId: "run-error",
      seq: 1,
      eventType: "error",
      stream: "system",
      message: "failed",
      payload: null,
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev002"]);
  });

  it("starts the successor on a new session after terminal error retirement", async () => {
    const callbacks: Array<(event: AgentSessionEvent) => void | Promise<void>> = [];
    const { ctx, sendMessage } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callbacks.push(options.onEvent!);
        return { runId: `run-${callbacks.length}` };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    await handleSlackProviderWebhook(delivery("Ev002"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await callbacks[0]({
      sessionId: "session-1",
      runId: "run-1",
      seq: 1,
      eventType: "error",
      stream: "system",
      message: "failed",
      payload: null,
    });
    const successorPayload = ctx.events.emit.mock.calls.at(-1)![2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", successorPayload, runtime());
    expect(sendMessage.mock.calls.map(([sessionId]) => sessionId)).toEqual(["session-1", "session-2"]);
  });

  it("buffers pre-send-result events, binds callbacks to the accepted run, and ignores stale callbacks", async () => {
    const send = deferred<{ runId: string }>();
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        await callback({
          sessionId: "session-1",
          runId: "run-right",
          seq: 1,
          eventType: "chunk",
          stream: "stdout",
          message: '{"type":"result","result":"right reply"}\n',
          payload: null,
        });
        await callback({
          sessionId: "session-1",
          runId: "run-stale",
          seq: 2,
          eventType: "done",
          stream: "system",
          message: null,
          payload: null,
        });
        return send.promise;
      },
    });
    const postReply = vi.fn(async () => undefined);
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    const drain = drainSlackConversationQueue(ctx as never, "co-1", payload, runtime(postReply));
    await vi.waitFor(() => expect(callback).toBeTypeOf("function"));

    send.resolve({ runId: "run-right" });
    await drain;
    await callback({
      sessionId: "session-1",
      runId: "run-right",
      seq: 3,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    expect(postReply).toHaveBeenCalledOnce();
    expect(postReply).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-right", text: "right reply" }));

    await callback({
      sessionId: "session-1",
      runId: "run-stale",
      seq: 4,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    expect(postReply).toHaveBeenCalledOnce();
  });

  it("fails closed when pre-accept callback buffering exceeds its bound", async () => {
    const send = deferred<{ runId: string }>();
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx, store, close } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return send.promise;
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    const drain = drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await vi.waitFor(() => expect(callback).toBeTypeOf("function"));

    for (let index = 0; index < 257; index += 1) {
      await callback({
        sessionId: "session-1",
        runId: "run-overflow",
        seq: index,
        eventType: "status",
        stream: "system",
        message: null,
        payload: null,
      });
    }
    send.resolve({ runId: "run-overflow" });
    await drain;

    expect(close).toHaveBeenCalledWith("session-1", "co-1");
    expect(queueState(store).active).toBeUndefined();
    expect(queueState(store).completed).toHaveLength(1);
  });

  it("ignores pre-accept callbacks for a stale session during missing-session recovery", async () => {
    const callbacks: Array<(event: AgentSessionEvent) => void | Promise<void>> = [];
    let sendCount = 0;
    const postReply = vi.fn(async () => undefined);
    const { ctx } = makeCtx({
      sendMessage: async (sessionId, _companyId, options) => {
        callbacks.push(options.onEvent!);
        sendCount += 1;
        if (sendCount === 1) {
          await options.onEvent?.({
            sessionId,
            runId: "run-stale",
            seq: 1,
            eventType: "chunk",
            stream: "stdout",
            message: "stale output",
            payload: null,
          });
          throw new Error(`Session not found: ${sessionId}`);
        }
        return { runId: "run-right" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime(postReply));

    await callbacks[1]({
      sessionId: "session-2",
      runId: "run-right",
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });
    expect(postReply).not.toHaveBeenCalled();
  });

  it("classifies an ambiguous send failure as uncertain, retires the session, completes the claim, and never auto-resends", async () => {
    const retirement = deferred<void>();
    const { ctx, store, sendMessage, close } = makeCtx({
      sendMessage: async () => { throw new Error("connection reset after request write"); },
      close: async () => retirement.promise,
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    const drain = drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await vi.waitFor(() => expect(queueState(store).active?.phase).toBe("uncertain"));
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith("session-1", "co-1");

    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    expect(queueState(store).pending).toHaveLength(0);
    expect(sendMessage).toHaveBeenCalledOnce();

    retirement.resolve();
    await expect(drain).resolves.toBeUndefined();
    expect(queueState(store).active).toBeUndefined();
    expect(queueState(store).completed).toHaveLength(1);

    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("treats a send result without a run ID as ambiguous and never retries it", async () => {
    const { ctx, store, sendMessage, close } = makeCtx({
      sendMessage: async () => ({ runId: "" }),
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(close).toHaveBeenCalledWith("session-1", "co-1");
    expect(queueState(store).completed).toHaveLength(1);

    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("never exposes an ambiguous send error message in ingress logs", async () => {
    const sensitive = "transport failed with Authorization: Bearer xoxb-sensitive";
    const { ctx } = makeCtx({ sendMessage: async () => { throw new Error(sensitive); } });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());

    expect(JSON.stringify(ctx.logger.error.mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(ctx.logger.error.mock.calls)).not.toContain("xoxb-sensitive");
  });

  it("keeps an ambiguous turn uncertain when session retirement fails", async () => {
    const retirementError = new Error("session close unavailable");
    const { ctx, store, sendMessage, close } = makeCtx({
      sendMessage: async () => { throw new Error("connection reset after request write"); },
      close: async () => { throw retirementError; },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow(
      retirementError,
    );
    expect(queueState(store).active?.phase).toBe("uncertain");
    expect(queueState(store).completed).toEqual([]);

    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow(
      retirementError,
    );
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("recovers only the definitive missing-session response on a replacement session", async () => {
    let sendCount = 0;
    const { ctx, sendMessage } = makeCtx({
      sendMessage: async (sessionId) => {
        sendCount += 1;
        if (sendCount === 1) throw new Error(`Session not found: ${sessionId}`);
        return { runId: "run-recovered" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;

    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    expect(sendMessage.mock.calls.map(([sessionId]) => sessionId)).toEqual(["session-1", "session-2"]);
  });

  it("retains a safe mapped session when pre-send setup fails", async () => {
    let callback!: (event: AgentSessionEvent) => void | Promise<void>;
    const { ctx, store } = makeCtx({
      sendMessage: async (_sessionId, _companyId, options) => {
        callback = options.onEvent!;
        return { runId: "run-1" };
      },
    });
    await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
    const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(ctx as never, "co-1", payload, runtime());
    await callback({
      sessionId: "session-1",
      runId: "run-1",
      seq: 1,
      eventType: "done",
      stream: "system",
      message: null,
      payload: null,
    });

    await handleSlackProviderWebhook(delivery("Ev002"), ctx as never);
    ctx.config.get.mockRejectedValueOnce(new Error("config unavailable"));
    await expect(drainSlackConversationQueue(ctx as never, "co-1", payload, runtime())).rejects.toThrow();
    expect(queueState(store).sessionId).toBe("session-1");
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev002"]);
  });

  it("does not retire an in-process pre-send host call merely because its lease elapses", async () => {
    vi.useFakeTimers();
    try {
      const send = deferred<{ runId: string }>();
      const { ctx, sendMessage, close } = makeCtx({ sendMessage: async () => send.promise });
      await handleSlackProviderWebhook(delivery("Ev001"), ctx as never);
      const payload = ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
      const shortRuntime = { ...runtime(), acceptedRunLeaseMs: 1_000 };
      const firstDrain = drainSlackConversationQueue(ctx as never, "co-1", payload, shortRuntime);
      await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());

      await vi.advanceTimersByTimeAsync(1_001);
      const secondDrain = drainSlackConversationQueue(ctx as never, "co-1", payload, shortRuntime);
      await Promise.resolve();
      expect(close).not.toHaveBeenCalled();
      send.resolve({ runId: "run-late-send" });
      await Promise.all([firstDrain, secondDrain]);
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes persisted work after a restart when a fresh duplicate webhook re-kicks it", async () => {
    const store = new Map<string, unknown>();
    const first = makeCtx({ store });
    await handleSlackProviderWebhook(delivery("Ev001"), first.ctx as never);
    expect(queueState(store).pending).toHaveLength(1);

    const restarted = makeCtx({ store, sendMessage: async () => ({ runId: "run-after-restart" }) });
    await handleSlackProviderWebhook(delivery("Ev001"), restarted.ctx as never);
    expect(restarted.ctx.events.emit).toHaveBeenCalledOnce();
    const payload = restarted.ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(restarted.ctx as never, "co-1", payload, runtime());
    expect(restarted.sendMessage).toHaveBeenCalledOnce();
  });

  it("a fresh new webhook also re-kicks older persisted work after restart", async () => {
    const store = new Map<string, unknown>();
    const first = makeCtx({ store });
    await handleSlackProviderWebhook(delivery("Ev001", "older"), first.ctx as never);

    const restarted = makeCtx({ store, sendMessage: async () => ({ runId: "run-after-restart" }) });
    await handleSlackProviderWebhook(delivery("Ev002", "newer"), restarted.ctx as never);
    const payload = restarted.ctx.events.emit.mock.calls[0][2] as SlackTurnDrainPayload;
    await drainSlackConversationQueue(restarted.ctx as never, "co-1", payload, runtime());

    expect(restarted.sendMessage).toHaveBeenCalledOnce();
    expect(restarted.sendMessage.mock.calls[0][2].prompt).toContain('"text":"older"');
    expect(queueState(store).pending.map((turn) => turn.eventId)).toEqual(["Ev002"]);
  });

  it("registers exactly one provider self-event handler", () => {
    const { ctx, eventHandlers } = makeCtx();
    contributeSlackIngress(ctx as never, async () => undefined);

    expect(ctx.events.on).toHaveBeenCalledOnce();
    expect(ctx.events.on).toHaveBeenCalledWith(SLACK_TURN_DRAIN_EVENT_TYPE, expect.any(Function));
    expect(eventHandlers.has(SLACK_TURN_DRAIN_EVENT_TYPE)).toBe(true);
  });

  it("rejects a non-positive accepted-run lease before registering the handler", () => {
    const { ctx } = makeCtx();
    expect(() => contributeSlackIngress(ctx as never, async () => undefined, undefined, 0)).toThrow(/positive/i);
    expect(ctx.events.on).not.toHaveBeenCalled();
  });

  it("ignores malformed self-event payloads without touching queue state", async () => {
    const { ctx, eventHandlers } = makeCtx();
    contributeSlackIngress(ctx as never, async () => undefined);
    const handler = eventHandlers.get(SLACK_TURN_DRAIN_EVENT_TYPE)!;

    await expect(handler({
      eventId: "event-1",
      eventType: SLACK_TURN_DRAIN_EVENT_TYPE,
      occurredAt: new Date().toISOString(),
      companyId: "co-1",
      payload: { agentId: "agent-1", conversationKey: "not-a-hash" },
    })).resolves.toBeUndefined();
    expect(ctx.state.get).not.toHaveBeenCalled();
  });

  it("rejects payload-provided company scope and uses only the fresh event scope", async () => {
    const { ctx, eventHandlers } = makeCtx();
    contributeSlackIngress(ctx as never, async () => undefined);
    const handler = eventHandlers.get(SLACK_TURN_DRAIN_EVENT_TYPE)!;

    await expect(handler({
      eventId: "event-1",
      eventType: SLACK_TURN_DRAIN_EVENT_TYPE,
      occurredAt: new Date().toISOString(),
      companyId: "co-other",
      payload: {
        agentId: "agent-1",
        conversationKey: "a".repeat(64),
        companyId: "co-1",
      },
    })).resolves.toBeUndefined();
    expect(ctx.config.get).not.toHaveBeenCalled();
    expect(ctx.state.get).not.toHaveBeenCalled();
  });

  it("keeps completed retention at least 35 minutes", () => {
    expect(SLACK_COMPLETED_EVENT_RETENTION_MS).toBeGreaterThanOrEqual(35 * 60 * 1_000);
    expect(SLACK_COMPLETED_EVENT_RETENTION_MS).toBeGreaterThan(SLACK_ACCEPTED_RUN_LEASE_MS);
  });

  it("answers signed URL verification without queueing or kicking", async () => {
    const { ctx, store } = makeCtx();
    const rawBody = JSON.stringify({ type: "url_verification", challenge: "challenge" });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    await expect(handleSlackProviderWebhook({
      endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
      companyId: "co-1",
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": sign(timestamp, rawBody),
      },
      rawBody,
      requestId: "req-challenge",
    }, ctx as never)).resolves.toEqual({ status: 200, body: "challenge" });
    expect(store.size).toBe(0);
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature without queueing or kicking", async () => {
    const { ctx, store } = makeCtx();
    const input = delivery("Ev-invalid-signature");
    input.headers["x-slack-signature"] = "v0=deadbeef";
    await expect(handleSlackProviderWebhook(input, ctx as never)).resolves.toEqual({
      status: 401,
      body: { error: "unauthorized" },
    });
    expect(store.size).toBe(0);
    expect(ctx.events.emit).not.toHaveBeenCalled();
  });

  it("fails closed before host reads when company scope is missing", async () => {
    const { ctx } = makeCtx();
    const input = { ...delivery("Ev001"), companyId: undefined };
    await expect(handleSlackProviderWebhook(input, ctx as never)).rejects.toThrow(/companyId/i);
    expect(ctx.config.get).not.toHaveBeenCalled();
    expect(ctx.state.get).not.toHaveBeenCalled();
  });

  it("fails closed on a whitespace-padded company scope", async () => {
    const { ctx } = makeCtx();
    await expect(handleSlackProviderWebhook({
      ...delivery("Ev001"),
      companyId: " co-1 ",
    }, ctx as never)).rejects.toThrow(/companyId is invalid/i);
    expect(ctx.config.get).not.toHaveBeenCalled();
  });

  it("registers the default 30-minute accepted lease", () => {
    const { ctx } = makeCtx();
    expect(SLACK_ACCEPTED_RUN_LEASE_MS).toBe(30 * 60 * 1_000);
    expect(() => contributeSlackIngress(ctx as never, async () => undefined))
      .not.toThrow();
  });

  it("does not install a detached host-calling timer", () => {
    const { ctx } = makeCtx();
    const timerSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      contributeSlackIngress(ctx as never, async () => undefined);
      expect(timerSpy).not.toHaveBeenCalled();
    } finally {
      timerSpy.mockRestore();
    }
  });

  it("registers no scheduled job for queue draining", () => {
    const { ctx } = makeCtx();
    expect((ctx as unknown as { jobs?: unknown }).jobs).toBeUndefined();
    contributeSlackIngress(ctx as never, async () => undefined);
    expect(ctx.events.on).toHaveBeenCalledOnce();
  });
});
