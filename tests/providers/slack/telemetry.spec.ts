import { describe, expect, it, vi } from "vitest";
import {
  contributeSlackTelemetryAction,
  getSlackTelemetry,
  recordSlackDeliveryOutcome,
  recordSlackIngressOutcome,
  SLACK_DELIVERY_FAILURE_GUIDANCE,
  SLACK_INGRESS_FAILURE_GUIDANCE,
} from "../../../src/providers/slack/telemetry.js";

const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";

// Mirrors the `makeState` fixture pattern used in
// ingress-conversation-queue.spec.ts (a bounded in-memory PluginStateClient
// double), reused here rather than re-derived.
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

describe("getSlackTelemetry / recordSlackIngressOutcome / recordSlackDeliveryOutcome", () => {
  it("reports null ingress/delivery when nothing has ever been observed", async () => {
    const state = makeState();
    const result = await getSlackTelemetry(state as never, "agent-1");
    expect(result).toEqual({ ingress: null, delivery: null });
  });

  it("records a healthy verified ingress event and projects it back", async () => {
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID, teamId: "T111", appId: "A111" },
      { ok: true, eventType: "app_mention" },
      1_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1");
    expect(result.ingress).toEqual({
      lastVerifiedEventAt: 1_000,
      lastEventType: "app_mention",
      lastRoutingResult: "routed",
    });
    expect(result.delivery).toBeNull();
  });

  it("records a routing failure with bounded category, reason, and operator guidance", async () => {
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: false, category: "routing_failed", reason: "No single configured agent identity matched." },
      2_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1");
    expect(result.ingress?.lastRoutingResult).toBe("routing_failed");
    expect(result.ingress?.lastFailure).toEqual({
      category: "routing_failed",
      reason: "No single configured agent identity matched.",
      nextStep: SLACK_INGRESS_FAILURE_GUIDANCE.routing_failed,
      at: 2_000,
    });
  });

  it("records a signature failure distinctly from a routing failure", async () => {
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: false, category: "signature_failed", reason: "Signature mismatch." },
      3_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1");
    expect(result.ingress?.lastFailure?.category).toBe("signature_failed");
    expect(result.ingress?.lastFailure?.nextStep).toBe(SLACK_INGRESS_FAILURE_GUIDANCE.signature_failed);
  });

  it("records a queue-full delivery failure with guidance", async () => {
    const state = makeState();
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "queue_failed", reason: "Queue is full." },
      4_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1");
    expect(result.delivery?.lastFailure).toEqual({
      category: "queue_failed",
      reason: "Queue is full.",
      nextStep: SLACK_DELIVERY_FAILURE_GUIDANCE.queue_failed,
      at: 4_000,
    });
    expect(result.delivery?.lastFailedAt).toBe(4_000);
  });

  it("records session and reply failure categories distinctly", async () => {
    const state = makeState();
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "session_failed", reason: "Session could not start." },
      5_000,
    );
    let result = await getSlackTelemetry(state as never, "agent-1");
    expect(result.delivery?.lastFailure?.category).toBe("session_failed");

    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "reply_failed", reason: "Reply send was ambiguous." },
      6_000,
    );
    result = await getSlackTelemetry(state as never, "agent-1");
    expect(result.delivery?.lastFailure?.category).toBe("reply_failed");
  });

  it("records the full enqueue -> drain -> completed delivery lifecycle", async () => {
    const state = makeState();
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "enqueued" },
      1_000,
    );
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "drain_started" },
      1_100,
    );
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "completed" },
      1_200,
    );
    const result = await getSlackTelemetry(state as never, "agent-1");
    expect(result.delivery).toEqual({
      lastEnqueuedAt: 1_000,
      lastDrainStartedAt: 1_100,
      lastCompletedAt: 1_200,
    });
  });

  it("scopes telemetry per agent so one agent's record never leaks into another's projection", async () => {
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: true, eventType: "message" },
      1_000,
    );
    const other = await getSlackTelemetry(state as never, "agent-2");
    expect(other).toEqual({ ingress: null, delivery: null });
  });

  it("never contains secret-shaped content (tokens, signing secrets) for bounded, non-secret reason text", async () => {
    // recordSlackIngressOutcome/recordSlackDeliveryOutcome accept `reason` as
    // a caller-supplied string. Every real call site (webhook-handler.ts,
    // provider-webhook.ts) passes only fixed, bounded, non-secret literal
    // text -- never a raw caught error message or Slack response body, which
    // could otherwise leak operational detail. This test exercises exactly
    // that contract: bounded operator-facing text round-trips untouched, and
    // the module itself introduces no secret-shaped content anywhere in the
    // persisted record (categories, timestamps, guidance strings).
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: false, category: "signature_failed", reason: "Slack request signature did not verify." },
      1_000,
    );
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "reply_failed", reason: "Slack reply send outcome was ambiguous." },
      2_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/xoxb-|xoxp-|"token"|"signingSecret"|Authorization:|Bearer /);
    for (const value of state.store.values()) {
      expect(JSON.stringify(value)).not.toMatch(/xoxb-|xoxp-|"token"|"signingSecret"|Authorization:|Bearer /);
    }
  });
});

describe("contributeSlackTelemetryAction", () => {
  function fakeCtx(state = makeState()) {
    const registered = new Map<string, (params: Record<string, unknown>, context: { companyId: string | null }) => Promise<unknown>>();
    const ctx = {
      state,
      actions: {
        register: (key: string, handler: (params: Record<string, unknown>, context: { companyId: string | null }) => Promise<unknown>) => {
          registered.set(key, handler);
        },
      },
    };
    return { ctx, registered, state };
  }

  it("registers get-slack-telemetry and returns nulls when nothing was ever observed", async () => {
    const { ctx, registered } = fakeCtx();
    contributeSlackTelemetryAction(ctx as never);
    const handler = registered.get("get-slack-telemetry");
    expect(handler).toBeTruthy();
    const result = await handler!({ agentId: "agent-1" }, { companyId: COMPANY_ID });
    expect(result).toEqual({ ingress: null, delivery: null });
  });

  it("projects a previously recorded healthy ingress event", async () => {
    const { ctx, registered, state } = fakeCtx();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: true, eventType: "message" },
      1_000,
    );
    contributeSlackTelemetryAction(ctx as never);
    const handler = registered.get("get-slack-telemetry")!;
    const result = (await handler({ agentId: "agent-1" }, { companyId: COMPANY_ID })) as Record<string, unknown>;
    expect((result.ingress as Record<string, unknown>).lastRoutingResult).toBe("routed");
  });

  it("rejects a request missing agentId", async () => {
    const { ctx, registered } = fakeCtx();
    contributeSlackTelemetryAction(ctx as never);
    const handler = registered.get("get-slack-telemetry")!;
    await expect(handler({}, { companyId: COMPANY_ID })).rejects.toThrow(/agentId/);
  });

  it("rejects a request without a host-authorized companyId", async () => {
    const { ctx, registered } = fakeCtx();
    contributeSlackTelemetryAction(ctx as never);
    const handler = registered.get("get-slack-telemetry")!;
    await expect(handler({ agentId: "agent-1" }, { companyId: null })).rejects.toThrow(/companyId/);
  });
});
