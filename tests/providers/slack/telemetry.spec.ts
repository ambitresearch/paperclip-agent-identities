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
const OTHER_COMPANY_ID = "00000000-0000-4000-8000-0000000000c2";

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
    const result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
    expect(result).toEqual({ ingress: null, delivery: null });
  });

  it("records a healthy verified ingress event and projects it back", async () => {
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID, teamId: "T111", appId: "A111" },
      { ok: true, eventType: "app_mention" },
      1_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
    expect(result.ingress).toEqual({
      lastVerifiedEventAt: 1_000,
      lastEventType: "app_mention",
      lastRoutingResult: "routed",
    });
    expect(result.delivery).toBeNull();
  });

  it("records a routing failure with bounded category and operator guidance", async () => {
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: false, category: "routing_failed" },
      2_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
    expect(result.ingress?.lastRoutingResult).toBe("routing_failed");
    expect(result.ingress?.lastFailure).toEqual({
      category: "routing_failed",
      nextStep: SLACK_INGRESS_FAILURE_GUIDANCE.routing_failed,
      at: 2_000,
    });
  });

  it("records a signature failure distinctly from a routing failure", async () => {
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: false, category: "signature_failed" },
      3_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
    expect(result.ingress?.lastFailure?.category).toBe("signature_failed");
    expect(result.ingress?.lastFailure?.nextStep).toBe(SLACK_INGRESS_FAILURE_GUIDANCE.signature_failed);
  });

  it("records a queue-full delivery failure with guidance", async () => {
    const state = makeState();
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "queue_failed" },
      4_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
    expect(result.delivery?.lastFailure).toEqual({
      category: "queue_failed",
      nextStep: SLACK_DELIVERY_FAILURE_GUIDANCE.queue_failed,
      at: 4_000,
    });
    expect(result.delivery?.lastFailedAt).toBe(4_000);
  });

  it("records session and reply failure categories distinctly", async () => {
    const state = makeState();
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "session_failed" },
      5_000,
    );
    let result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
    expect(result.delivery?.lastFailure?.category).toBe("session_failed");

    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "reply_failed" },
      6_000,
    );
    result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
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
    const result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
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
    const other = await getSlackTelemetry(state as never, "agent-2", COMPANY_ID);
    expect(other).toEqual({ ingress: null, delivery: null });
  });

  it("never leaks another company's telemetry for a known agentId (cross-company scope enforcement)", async () => {
    // The state key is scoped only by agentId, so an agentId alone must never
    // be sufficient to read another company's telemetry -- the stored
    // record's own companyId must match the caller's authorized companyId.
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "shared-agent", companyId: COMPANY_ID },
      { ok: true, eventType: "message" },
      1_000,
    );
    const ownerResult = await getSlackTelemetry(state as never, "shared-agent", COMPANY_ID);
    expect(ownerResult.ingress?.lastRoutingResult).toBe("routed");

    const otherCompanyResult = await getSlackTelemetry(state as never, "shared-agent", OTHER_COMPANY_ID);
    expect(otherCompanyResult).toEqual({ ingress: null, delivery: null });
  });

  it("never contains secret-shaped content anywhere in the persisted record", async () => {
    // Failure reasons are no longer caller-supplied free text -- only a fixed,
    // bounded category and its associated static guidance string are ever
    // persisted. This test exercises exactly that contract: the module
    // introduces no secret-shaped content anywhere in the persisted record
    // (categories, timestamps, guidance strings).
    const state = makeState();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { ok: false, category: "signature_failed" },
      1_000,
    );
    await recordSlackDeliveryOutcome(
      { state: state as never, agentId: "agent-1", companyId: COMPANY_ID },
      { phase: "failed", category: "reply_failed" },
      2_000,
    );
    const result = await getSlackTelemetry(state as never, "agent-1", COMPANY_ID);
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

  it("never returns another company's telemetry through the registered action for a shared agentId", async () => {
    const { ctx, registered, state } = fakeCtx();
    await recordSlackIngressOutcome(
      { state: state as never, agentId: "shared-agent", companyId: COMPANY_ID },
      { ok: true, eventType: "message" },
      1_000,
    );
    contributeSlackTelemetryAction(ctx as never);
    const handler = registered.get("get-slack-telemetry")!;
    const result = await handler({ agentId: "shared-agent" }, { companyId: OTHER_COMPANY_ID });
    expect(result).toEqual({ ingress: null, delivery: null });
  });
});
