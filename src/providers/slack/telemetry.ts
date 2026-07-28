import type { PluginContext, PluginStateClient } from "@paperclipai/plugin-sdk";
import { requireHumanSettingsActor } from "../../core/settings-action-authorization.js";
import { readSlackIdentityConfigEntry, validateSlackConfig } from "./config.js";

/**
 * DRO-1187: bounded, secret-free "Ingress" and "Delivery" health telemetry,
 * completing the Configured/Connection/Ingress/Delivery split deferred by
 * DRO-1161 (see connection-status.ts for the sibling "Connection" check).
 *
 * Ingress covers pre-queue outcomes: signature verification and event
 * routing. Delivery covers post-queue outcomes: enqueue, drain/session
 * start, completion, and failure. Both are recorded as a single small
 * bounded record per (companyId, agentId) scope -- never per-event history,
 * never message bodies/Slack text/prompts/outputs, never tokens, signing
 * material, headers, or stack traces.
 */

const SLACK_TELEMETRY_STATE_NAMESPACE = "slack-telemetry" as const;
const SLACK_TELEMETRY_STATE_KEY = "health" as const;
export const SLACK_TELEMETRY_STATE_VERSION = 1 as const;

const SLACK_TELEMETRY_FIELD_MAX_LENGTH = 256;

export type SlackIngressEventTypeCategory =
  | "message"
  | "app_mention"
  | "other";

export type SlackIngressFailureCategory =
  | "signature_failed"
  | "routing_failed";

export type SlackDeliveryFailureCategory =
  | "queue_failed"
  | "session_failed"
  | "reply_failed";

export interface SlackTelemetryFailure {
  readonly category: SlackIngressFailureCategory | SlackDeliveryFailureCategory;
  readonly nextStep: string;
  readonly at: number;
}

export interface SlackIngressTelemetry {
  readonly lastVerifiedEventAt?: number;
  readonly lastEventType?: SlackIngressEventTypeCategory;
  readonly lastRoutingResult?: "routed" | "routing_failed";
  readonly lastFailure?: SlackTelemetryFailure;
}

export interface SlackDeliveryTelemetry {
  readonly lastEnqueuedAt?: number;
  readonly lastDrainStartedAt?: number;
  readonly lastCompletedAt?: number;
  readonly lastFailedAt?: number;
  readonly lastFailure?: SlackTelemetryFailure;
}

export interface SlackTelemetryRecord {
  readonly version: typeof SLACK_TELEMETRY_STATE_VERSION;
  readonly companyId: string;
  /** Correlation-safe scoping identifiers already treated as safe elsewhere in this provider. */
  readonly teamId?: string;
  readonly appId?: string;
  readonly ingress?: SlackIngressTelemetry;
  readonly delivery?: SlackDeliveryTelemetry;
}

export const SLACK_INGRESS_FAILURE_GUIDANCE: Record<SlackIngressFailureCategory, string> = {
  signature_failed:
    "Slack's request signature did not verify against the configured signing secret. Confirm the signing secret reference matches the Slack App's Basic Information page, and that the Events Request URL is configured for this exact app.",
  routing_failed:
    "No configured agent identity (or more than one) matched this event's Slack app/team. Verify exactly one identity is configured for this Slack app and workspace.",
};

export const SLACK_DELIVERY_FAILURE_GUIDANCE: Record<SlackDeliveryFailureCategory, string> = {
  queue_failed:
    "The durable conversation queue was full or in conflict when this event arrived. Slack will retry the delivery; if this persists, a conversation may be stuck -- check for a long-running or stalled session.",
  session_failed:
    "Starting or resuming the agent session for this conversation failed. Retry is automatic on the next inbound event; if it persists, check the agent's session health directly.",
  reply_failed:
    "Sending the agent's reply back to Slack failed or was ambiguous, so it was not retried automatically to avoid a duplicate reply. The operator may need to re-prompt the agent in Slack.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = SLACK_TELEMETRY_FIELD_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertSafeScopeSegment(agentId: string): void {
  if (!agentId || agentId !== agentId.trim() || agentId.length > SLACK_TELEMETRY_FIELD_MAX_LENGTH) {
    throw new Error("Slack telemetry agentId is invalid.");
  }
}

function slackTelemetryStateKey(agentId: string) {
  assertSafeScopeSegment(agentId);
  return {
    scopeKind: "agent" as const,
    scopeId: agentId,
    namespace: SLACK_TELEMETRY_STATE_NAMESPACE,
    stateKey: SLACK_TELEMETRY_STATE_KEY,
  };
}

function parseFailure(value: unknown, categories: readonly string[]): SlackTelemetryFailure | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !categories.includes(String(value.category)) ||
    !isBoundedString(value.nextStep, 1024) ||
    !isFiniteTimestamp(value.at) ||
    Object.keys(value).some((key) => !["category", "nextStep", "at"].includes(key))
  ) {
    return undefined;
  }
  return {
    category: value.category as SlackTelemetryFailure["category"],
    nextStep: value.nextStep,
    at: value.at,
  };
}

function parseIngress(value: unknown): SlackIngressTelemetry | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) =>
    !["lastVerifiedEventAt", "lastEventType", "lastRoutingResult", "lastFailure"].includes(key))) {
    return undefined;
  }
  const lastVerifiedEventAt = value.lastVerifiedEventAt === undefined
    ? undefined
    : isFiniteTimestamp(value.lastVerifiedEventAt) ? value.lastVerifiedEventAt : undefined;
  const lastEventType = ["message", "app_mention", "other"].includes(String(value.lastEventType))
    ? (value.lastEventType as SlackIngressEventTypeCategory)
    : undefined;
  const lastRoutingResult = ["routed", "routing_failed"].includes(String(value.lastRoutingResult))
    ? (value.lastRoutingResult as SlackIngressTelemetry["lastRoutingResult"])
    : undefined;
  const lastFailure = parseFailure(value.lastFailure, ["signature_failed", "routing_failed"]);
  return { lastVerifiedEventAt, lastEventType, lastRoutingResult, lastFailure };
}

function parseDelivery(value: unknown): SlackDeliveryTelemetry | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (Object.keys(value).some((key) =>
    !["lastEnqueuedAt", "lastDrainStartedAt", "lastCompletedAt", "lastFailedAt", "lastFailure"].includes(key))) {
    return undefined;
  }
  const timestamp = (field: unknown) => (field === undefined ? undefined : isFiniteTimestamp(field) ? field : undefined);
  const lastFailure = parseFailure(value.lastFailure, ["queue_failed", "session_failed", "reply_failed"]);
  return {
    lastEnqueuedAt: timestamp(value.lastEnqueuedAt),
    lastDrainStartedAt: timestamp(value.lastDrainStartedAt),
    lastCompletedAt: timestamp(value.lastCompletedAt),
    lastFailedAt: timestamp(value.lastFailedAt),
    lastFailure,
  };
}

function parseTelemetryRecord(value: unknown): SlackTelemetryRecord | null {
  if (!isRecord(value) || value.version !== SLACK_TELEMETRY_STATE_VERSION) return null;
  if (!isBoundedString(value.companyId)) return null;
  if (Object.keys(value).some((key) =>
    !["version", "companyId", "teamId", "appId", "ingress", "delivery"].includes(key))) {
    return null;
  }
  const teamId = value.teamId === undefined ? undefined : isBoundedString(value.teamId) ? value.teamId : undefined;
  const appId = value.appId === undefined ? undefined : isBoundedString(value.appId) ? value.appId : undefined;
  return {
    version: SLACK_TELEMETRY_STATE_VERSION,
    companyId: value.companyId,
    ...(teamId ? { teamId } : {}),
    ...(appId ? { appId } : {}),
    ...(parseIngress(value.ingress) ? { ingress: parseIngress(value.ingress) } : {}),
    ...(parseDelivery(value.delivery) ? { delivery: parseDelivery(value.delivery) } : {}),
  };
}

/**
 * Binding scope a record belongs to beyond (companyId, agentId): the Slack
 * workspace and app the agent identity is currently bound to. Rebinding an
 * agent to a different Slack app/workspace must not merge into, or project,
 * the previous binding's record.
 */
export interface SlackTelemetryBinding {
  readonly teamId?: string;
  readonly appId?: string;
}

function normalizeBindingId(value: unknown): string | undefined {
  return isBoundedString(value) && value.trim() === value ? value : undefined;
}

/**
 * Fail-closed binding check: when both the stored record and the requested
 * scope name a teamId (or appId) and they differ, the stored record belongs
 * to a previous Slack app/workspace binding and must be treated as absent
 * (readers project nothing; writers start a fresh record rather than merging
 * into the stale one). A caller that cannot name its binding (unknown
 * team/app) imposes no constraint, exactly as before.
 */
function bindingMatches(record: SlackTelemetryRecord, binding: SlackTelemetryBinding): boolean {
  const teamId = normalizeBindingId(binding.teamId);
  const appId = normalizeBindingId(binding.appId);
  if (teamId !== undefined && record.teamId !== undefined && record.teamId !== teamId) return false;
  if (appId !== undefined && record.appId !== undefined && record.appId !== appId) return false;
  return true;
}

async function readTelemetryRecord(
  state: PluginStateClient,
  agentId: string,
  companyId: string,
  binding: SlackTelemetryBinding = {},
): Promise<SlackTelemetryRecord | null> {
  const raw = await state.get(slackTelemetryStateKey(agentId));
  if (raw === null || raw === undefined) return null;
  const parsed = parseTelemetryRecord(raw);
  if (!parsed) return null;
  // Enforce that the stored record actually belongs to the caller's company
  // scope. The state key is scoped by agentId alone, so without this check a
  // caller who merely knows a valid agentId could read another company's
  // telemetry for that agent.
  if (parsed.companyId !== companyId) return null;
  // ...and to the caller's current Slack app/workspace binding.
  if (!bindingMatches(parsed, binding)) return null;
  return parsed;
}

async function writeTelemetryRecord(
  state: PluginStateClient,
  agentId: string,
  next: SlackTelemetryRecord,
): Promise<void> {
  const serialized = structuredClone(next);
  await state.set(slackTelemetryStateKey(agentId), serialized);
}

/**
 * Serializes telemetry read-modify-write cycles per (state client, company,
 * agent) so a concurrent ingress record and delivery record cannot read the
 * same base record and clobber each other's branch. Mirrors the queue code's
 * `withConversationMutation` gate in `ingress/conversation-session.ts` --
 * same in-process tail-chaining shape, keyed per state client so tests with
 * independent stores never contend.
 */
const telemetryMutationTailsByState = new WeakMap<PluginStateClient, Map<string, Promise<void>>>();

async function withTelemetryMutation<T>(
  state: PluginStateClient,
  companyId: string,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = telemetryMutationTailsByState.get(state);
  if (!tails) {
    tails = new Map();
    telemetryMutationTailsByState.set(state, tails);
  }
  const key = `${companyId}:${agentId}`;
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

export interface SlackTelemetryScope {
  readonly state: PluginStateClient;
  readonly agentId: string;
  readonly companyId: string;
  readonly teamId?: string;
  readonly appId?: string;
}

export type SlackIngressOutcome =
  | { readonly ok: true; readonly eventType: SlackIngressEventTypeCategory }
  | { readonly ok: false; readonly category: SlackIngressFailureCategory };

export type SlackDeliveryOutcome =
  | { readonly phase: "enqueued" }
  | { readonly phase: "drain_started" }
  | { readonly phase: "completed" }
  | { readonly phase: "failed"; readonly category: SlackDeliveryFailureCategory };

function assertScope(scope: SlackTelemetryScope): void {
  if (!scope || typeof scope !== "object" || !scope.state) {
    throw new Error("Slack telemetry scope is invalid.");
  }
  if (!isBoundedString(scope.companyId) || scope.companyId !== scope.companyId.trim()) {
    throw new Error("Slack telemetry requires a valid company scope.");
  }
}

/** Records the outcome of one verified (post-signature-check) ingress attempt. */
export async function recordSlackIngressOutcome(
  scope: SlackTelemetryScope,
  outcome: SlackIngressOutcome,
  nowMs = Date.now(),
): Promise<void> {
  assertScope(scope);
  if (!isFiniteTimestamp(nowMs)) throw new Error("Slack telemetry timestamp is invalid.");
  await withTelemetryMutation(scope.state, scope.companyId, scope.agentId, async () => {
    const existing = (await readTelemetryRecord(scope.state, scope.agentId, scope.companyId, scope)) ?? {
      version: SLACK_TELEMETRY_STATE_VERSION,
      companyId: scope.companyId,
    };
    const ingress: SlackIngressTelemetry = outcome.ok
      ? {
          lastVerifiedEventAt: nowMs,
          lastEventType: outcome.eventType,
          lastRoutingResult: "routed",
        }
      : {
          ...existing.ingress,
          lastRoutingResult: "routing_failed",
          lastFailure: {
            category: outcome.category,
            nextStep: SLACK_INGRESS_FAILURE_GUIDANCE[outcome.category],
            at: nowMs,
          },
        };
    await writeTelemetryRecord(scope.state, scope.agentId, {
      ...existing,
      companyId: scope.companyId,
      ...(scope.teamId ? { teamId: scope.teamId } : {}),
      ...(scope.appId ? { appId: scope.appId } : {}),
      ingress,
    });
  });
}

/** Records one delivery-phase transition (enqueue, drain/session start, completion, or failure). */
export async function recordSlackDeliveryOutcome(
  scope: SlackTelemetryScope,
  outcome: SlackDeliveryOutcome,
  nowMs = Date.now(),
): Promise<void> {
  assertScope(scope);
  if (!isFiniteTimestamp(nowMs)) throw new Error("Slack telemetry timestamp is invalid.");
  await withTelemetryMutation(scope.state, scope.companyId, scope.agentId, async () => {
    const existing = (await readTelemetryRecord(scope.state, scope.agentId, scope.companyId, scope)) ?? {
      version: SLACK_TELEMETRY_STATE_VERSION,
      companyId: scope.companyId,
    };
    const priorDelivery = existing.delivery;
    let delivery: SlackDeliveryTelemetry;
    switch (outcome.phase) {
      case "enqueued":
        delivery = { ...priorDelivery, lastEnqueuedAt: nowMs };
        break;
      case "drain_started":
        delivery = { ...priorDelivery, lastDrainStartedAt: nowMs };
        break;
      case "completed":
        // A later successful completion supersedes an earlier failure record --
        // clear lastFailure/lastFailedAt so the panel doesn't show a completed
        // turn and a stale failure as simultaneous, contradictory health.
        delivery = {
          ...priorDelivery,
          lastCompletedAt: nowMs,
          lastFailedAt: undefined,
          lastFailure: undefined,
        };
        break;
      case "failed":
        delivery = {
          ...priorDelivery,
          lastFailedAt: nowMs,
          lastFailure: {
            category: outcome.category,
            nextStep: SLACK_DELIVERY_FAILURE_GUIDANCE[outcome.category],
            at: nowMs,
          },
        };
        break;
      default:
        throw new Error("Slack delivery telemetry phase is invalid.");
    }
    await writeTelemetryRecord(scope.state, scope.agentId, {
      ...existing,
      companyId: scope.companyId,
      ...(scope.teamId ? { teamId: scope.teamId } : {}),
      ...(scope.appId ? { appId: scope.appId } : {}),
      delivery,
    });
  });
}

/** Secret-free projection returned to Settings; absent when never observed. */
export interface SlackTelemetryProjection {
  readonly ingress: SlackIngressTelemetry | null;
  readonly delivery: SlackDeliveryTelemetry | null;
}

export async function getSlackTelemetry(
  state: PluginStateClient,
  agentId: string,
  companyId: string,
  binding: SlackTelemetryBinding = {},
): Promise<SlackTelemetryProjection> {
  const record = await readTelemetryRecord(state, agentId, companyId, binding);
  return {
    ingress: record?.ingress ?? null,
    delivery: record?.delivery ?? null,
  };
}

const SLACK_TELEMETRY_ACTION = "get-slack-telemetry";

/**
 * Registers the `get-slack-telemetry` read-only settings action. Returns
 * only bounded, non-secret ingress/delivery projections -- no bodies, no
 * secrets, no raw request/response data. Safe to call before any event has
 * ever been observed (returns nulls, rendered as "never observed").
 */
export function contributeSlackTelemetryAction(ctx: PluginContext): void {
  ctx.actions.register(SLACK_TELEMETRY_ACTION, async (params, context) => {
    requireHumanSettingsActor(context);
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      throw new Error("agentId is required to read Slack telemetry.");
    }
    const companyId = typeof context.companyId === "string" ? context.companyId.trim() : "";
    if (!companyId) {
      throw new Error("A host-authorized companyId is required to read Slack telemetry.");
    }
    return getSlackTelemetry(ctx.state, agentId, companyId, await readCurrentBinding(ctx, companyId, agentId));
  });
}

/**
 * Reads the agent's *currently configured* Slack workspace/app binding so a
 * record written under a previous Slack app/workspace binding is never
 * projected into Settings after a rebind. Config read failures degrade to an
 * unconstrained binding (the companyId check still applies) rather than
 * failing the read-only projection.
 */
async function readCurrentBinding(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
): Promise<SlackTelemetryBinding> {
  try {
    const config = await ctx.config.get(companyId);
    const entry = readSlackIdentityConfigEntry(config, agentId);
    const validated = entry ? validateSlackConfig(entry.value) : undefined;
    if (!validated || typeof validated === "string") return {};
    return {
      ...(validated.teamId ? { teamId: validated.teamId } : {}),
      ...(validated.appId ? { appId: validated.appId } : {}),
    };
  } catch {
    return {};
  }
}
