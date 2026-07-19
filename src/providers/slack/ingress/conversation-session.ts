import { createHash, randomUUID } from "node:crypto";
import type { PluginStateClient } from "@paperclipai/plugin-sdk";

const SLACK_CONVERSATION_STATE_NAMESPACE = "slack-conversations" as const;
const SLACK_CONVERSATION_STATE_KEY_PREFIX = "session:" as const;
export const SLACK_CONVERSATION_STATE_VERSION = 2 as const;
const LEGACY_SESSION_STATE_VERSION = 1 as const;
const LEGACY_DEDUP_NAMESPACE = "slack-ingress";
const LEGACY_DEDUP_STATE_KEY = "event-ledger";

// Persisted bounds are deliberately conservative: one record remains small
// enough for plugin state while covering Slack's retry and host run horizons.
export const SLACK_PENDING_TURN_LIMIT = 32;
export const SLACK_EVENT_CLAIM_LIMIT = 1_024;
export const SLACK_COMPLETED_EVENT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const SLACK_TURN_FIELD_MAX_LENGTH = 256;
export const SLACK_TURN_TEXT_MAX_LENGTH = 4_096;
export const SLACK_EVENT_ID_MAX_LENGTH = 128;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLACK_MESSAGE_TS_PATTERN = /^[0-9]{10,}\.[0-9]{6}$/;
export const SLACK_TURN_TEXT_MAX_BYTES = 65_536;
const queueNowMs = () => Date.now();



export interface SlackConversationTarget {
  readonly teamId: string;
  readonly appId: string;
  readonly channel: string;
  readonly threadTs?: string;
}

type SlackTurnStartMode = "direct" | "mention" | "broadcast" | "owned-reply";

export interface SlackQueuedTurnEvent {
  readonly type: string;
  readonly channel: string;
  readonly channelType?: "im" | "channel" | "group" | "mpim";
  readonly text?: string;
  readonly user?: string;
  readonly ts?: string;
  readonly threadTs?: string;
}

export interface SlackQueuedTurn {
  readonly claimId: string;
  readonly eventId: string;
  readonly eventHash: string;
  readonly enqueuedAt: number;
  readonly event: SlackQueuedTurnEvent;
}

interface SlackActiveTurnBase {
  readonly attemptId: string;
  readonly turn: SlackQueuedTurn;
  readonly sessionId?: string;
}

interface SlackStartingTurn extends SlackActiveTurnBase {
  readonly phase: "active";
  readonly startedAt: number;
  readonly retireAfter: number;
}

export interface SlackAcceptedTurn extends SlackActiveTurnBase {
  readonly phase: "accepted";
  readonly sessionId: string;
  readonly runId: string;
  readonly acceptedAt: number;
  readonly retireAfter: number;
}

interface SlackUncertainTurn extends SlackActiveTurnBase {
  readonly phase: "uncertain";
  readonly uncertainAt: number;
  readonly reason: "send-failed" | "lease-expired" | "ownership-lost";
}

export type SlackActiveTurn = SlackStartingTurn | SlackAcceptedTurn | SlackUncertainTurn;

interface SlackCompletedEventClaim {
  readonly eventHash: string;
  readonly completedAt: number;
  readonly claimId: string;
}

interface SlackLegacyAcceptedRun {
  readonly sessionId: string;
  readonly runId: string;
  readonly retireAfter: number;
  readonly phase: "accepted" | "uncertain";
}

interface SlackLegacyEventClaim {
  readonly eventHash: string;
}

export interface SlackConversationState {
  readonly version: typeof SLACK_CONVERSATION_STATE_VERSION;
  readonly companyId: string;
  readonly conversation: SlackConversationTarget;
  owned: boolean;
  sessionId?: string;
  pending: SlackQueuedTurn[];
  active?: SlackActiveTurn;
  completed: SlackCompletedEventClaim[];
  legacyAcceptedRun?: SlackLegacyAcceptedRun;
  legacyClaims?: SlackLegacyEventClaim[];
}

interface SlackConversationStateKey {
  readonly scopeKind: "agent";
  readonly scopeId: string;
  readonly namespace: typeof SLACK_CONVERSATION_STATE_NAMESPACE;
  readonly stateKey: string;
}

/** Secret-free status projection; it never exposes event, session, or run IDs. */
export interface SlackConversationQueueSummary {
  readonly version: typeof SLACK_CONVERSATION_STATE_VERSION;
  readonly status: SlackConversationQueueStatus;
  readonly pendingCount: number;
  readonly hasSession: boolean;
  readonly completedCount: number;
  readonly atCapacity: boolean;
}

type SlackConversationQueueStatus = "idle" | "queued" | "active" | "accepted" | "uncertain";

export interface SlackConversationReference {
  readonly state: PluginStateClient;
  readonly agentId: string;
  readonly companyId: string;
  readonly conversationKey: string;
  readonly conversation?: SlackConversationTarget;
}

/** Safe, already-routed Slack fields accepted by the durable enqueue boundary. */
export interface EnqueueSlackConversationTurnInput {
  readonly state: PluginStateClient;
  readonly agentId: string;
  readonly companyId: string;
  readonly conversation: SlackConversationTarget;
  readonly eventId: string;
  readonly event: {
    readonly type: string;
    readonly channel: string;
    readonly channelType?: "im" | "channel" | "group" | "mpim";
    readonly text?: string;
    readonly user?: string;
    readonly ts?: string;
    readonly threadTs?: string;
  };
  readonly startMode: SlackTurnStartMode;
  readonly nowMs?: number;
}

/** `enqueued` and `ignored` are newly persisted; `duplicate` was already durable. */
export interface EnqueueSlackConversationTurnResult {
  readonly status: "enqueued" | "duplicate" | "ignored";
  readonly conversationKey: string;
}

export class SlackConversationQueueFullError extends Error {
  readonly code = "SLACK_QUEUE_FULL" as const;
  readonly retryable = true as const;

  constructor(message: string) {
    super(message);
    this.name = "SlackConversationQueueFullError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class SlackConversationStateConflictError extends Error {
  readonly code = "SLACK_QUEUE_STATE_CONFLICT" as const;
  readonly retryable = true as const;

  constructor(message = "Slack conversation queue state conflict; retry the delivery.") {
    super(message);
    this.name = "SlackConversationStateConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Identifies queue-capacity/CAS-style failures that must prevent webhook ack. */
export function isRetryableSlackQueueError(error: unknown): boolean {
  return error instanceof Error && isRecord(error) && (
    error.code === "SLACK_QUEUE_FULL" ||
    error.code === "SLACK_QUEUE_STATE_CONFLICT"
  );
}

interface LegacyStoredConversationSession {
  readonly version: typeof LEGACY_SESSION_STATE_VERSION;
  readonly sessionId: string;
  readonly retired?: true;
  readonly acceptedRun?: {
    readonly runId: string;
    readonly retireAfter: number;
  };
}

interface ConversationMutation<T> {
  readonly result: T;
  readonly changed?: boolean;
}

function emptyConversationState(
  companyId: string,
  conversation: SlackConversationTarget,
): SlackConversationState {
  return {
    version: SLACK_CONVERSATION_STATE_VERSION,
    companyId,
    conversation,
    owned: false,
    pending: [],
    completed: [],
  };
}

// The SDK has no CAS. This lock gives deterministic ordering in one worker;
// claim-token read-back detects only observable cross-worker write races.
const mutationTailsByState = new WeakMap<PluginStateClient, Map<string, Promise<void>>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength = SLACK_TURN_FIELD_MAX_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function cloneQueueValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new Error("Slack conversation queue state is not serializable.");
  }
}

function parseConversation(value: unknown): SlackConversationTarget | null {
  if (!isRecord(value)) return null;
  if (
    !isBoundedString(value.teamId) ||
    !isBoundedString(value.appId) ||
    !isBoundedString(value.channel) ||
    (value.threadTs !== undefined && !isBoundedString(value.threadTs))
  ) {
    return null;
  }
  if ([value.teamId, value.appId, value.channel, value.threadTs].some(
    (field) => typeof field === "string" && field !== field.trim(),
  )) {
    return null;
  }
  if (Object.keys(value).some((key) => !["teamId", "appId", "channel", "threadTs"].includes(key))) {
    return null;
  }
  if (!/^T[A-Za-z0-9-]{2,}$/.test(value.teamId) || !/^A[A-Za-z0-9-]{2,}$/.test(value.appId)) return null;
  if (!/^[CDG][A-Za-z0-9-]{2,}$/.test(value.channel)) return null;
  if (value.threadTs !== undefined && !SLACK_MESSAGE_TS_PATTERN.test(value.threadTs)) return null;
  if (value.channel.startsWith("D") && value.threadTs) return null;
  return {
    teamId: value.teamId,
    appId: value.appId,
    channel: value.channel,
    ...(value.threadTs ? { threadTs: value.threadTs } : {}),
  };
}

function parseTurnEvent(value: unknown): SlackQueuedTurnEvent | null {
  if (!isRecord(value) || !isBoundedString(value.type) || !isBoundedString(value.channel)) return null;
  if (value.text !== undefined && !isBoundedString(value.text, SLACK_TURN_TEXT_MAX_LENGTH)) return null;
  if (typeof value.text === "string" && Buffer.byteLength(value.text, "utf8") > SLACK_TURN_TEXT_MAX_BYTES) return null;
  for (const field of ["user", "ts", "threadTs"] as const) {
    if (value[field] !== undefined && !isBoundedString(value[field])) return null;
  }
  if (value.channelType !== undefined && !["im", "channel", "group", "mpim"].includes(String(value.channelType))) {
    return null;
  }
  if (value.channelType === "im" && !String(value.channel).startsWith("D")) return null;
  if (value.channelType !== undefined && value.channelType !== "im" && String(value.channel).startsWith("D")) return null;
  if (value.channelType === "channel" && !String(value.channel).startsWith("C")) return null;
  if ((value.channelType === "group" || value.channelType === "mpim") && !String(value.channel).startsWith("G")) return null;
  if (value.type === "app_mention" && value.channelType === "im") return null;
  if ([value.type, value.channel, value.channelType, value.user, value.ts, value.threadTs].some(
    (field) => typeof field === "string" && field !== field.trim(),
  )) return null;
  if (Object.keys(value).some((key) =>
    !["type", "channel", "channelType", "text", "user", "ts", "threadTs"].includes(key))) {
    return null;
  }
  return {
    type: value.type,
    channel: value.channel,
    ...(value.channelType ? { channelType: value.channelType as SlackQueuedTurnEvent["channelType"] } : {}),
    ...(value.text ? { text: value.text } : {}),
    ...(value.user ? { user: value.user as string } : {}),
    ...(value.ts ? { ts: value.ts as string } : {}),
    ...(value.threadTs ? { threadTs: value.threadTs as string } : {}),
  };
}

function parseTurn(value: unknown): SlackQueuedTurn | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) =>
    !["claimId", "eventId", "eventHash", "enqueuedAt", "event"].includes(key))) {
    return null;
  }
  const event = parseTurnEvent(value.event);
  if (
    !isBoundedString(value.claimId) ||
    !UUID_V4_PATTERN.test(value.claimId) ||
    !isBoundedString(value.eventId, SLACK_EVENT_ID_MAX_LENGTH) ||
    typeof value.eventHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.eventHash) ||
    !isFiniteTimestamp(value.enqueuedAt) ||
    !event
  ) {
    return null;
  }
  // New rows store bounded Slack event IDs (Slack's documented IDs are well
  // below this limit), so hash integrity can be checked on every read.
  try {
    if (value.eventHash !== slackEventHash(value.eventId)) return null;
  } catch {
    return null;
  }
  if (event.channel !== event.channel.trim()) return null;
  if (value.eventId !== value.eventId.trim() || value.claimId !== value.claimId.trim()) return null;
  return {
    claimId: value.claimId,
    eventId: value.eventId,
    eventHash: value.eventHash,
    enqueuedAt: value.enqueuedAt,
    event,
  };
}

function parseActiveTurn(value: unknown): SlackActiveTurn | null {
  if (!isRecord(value) || !isBoundedString(value.attemptId)) return null;
  if (!UUID_V4_PATTERN.test(value.attemptId)) return null;
  if (value.attemptId !== value.attemptId.trim()) return null;
  const turn = parseTurn(value.turn);
  if (!turn) return null;
  const sessionId = value.sessionId === undefined
    ? undefined
    : isBoundedString(value.sessionId) ? value.sessionId : null;
  if (sessionId === null) return null;
  if (sessionId && sessionId !== sessionId.trim()) return null;

  if (value.phase === "active") {
    if (Object.keys(value).some((key) =>
      !["phase", "attemptId", "turn", "startedAt", "retireAfter", "sessionId"].includes(key))) return null;
    if (!isFiniteTimestamp(value.startedAt) || !isFiniteTimestamp(value.retireAfter)) return null;
    return {
      phase: "active",
      attemptId: value.attemptId,
      turn,
      startedAt: value.startedAt,
      retireAfter: value.retireAfter,
      ...(sessionId ? { sessionId } : {}),
    };
  }
  if (value.phase === "accepted") {
    if (Object.keys(value).some((key) =>
      !["phase", "attemptId", "turn", "sessionId", "runId", "acceptedAt", "retireAfter"].includes(key))) return null;
    if (
      !sessionId ||
      !isBoundedString(value.runId) ||
      !isFiniteTimestamp(value.acceptedAt) ||
      !isFiniteTimestamp(value.retireAfter)
    ) {
      return null;
    }
    if (value.runId !== value.runId.trim()) return null;
    return {
      phase: "accepted",
      attemptId: value.attemptId,
      turn,
      sessionId,
      runId: value.runId,
      acceptedAt: value.acceptedAt,
      retireAfter: value.retireAfter,
    };
  }
  if (value.phase === "uncertain") {
    if (Object.keys(value).some((key) =>
      !["phase", "attemptId", "turn", "sessionId", "uncertainAt", "reason"].includes(key))) return null;
    if (
      !isFiniteTimestamp(value.uncertainAt) ||
      !["send-failed", "lease-expired", "ownership-lost"].includes(String(value.reason))
    ) {
      return null;
    }
    return {
      phase: "uncertain",
      attemptId: value.attemptId,
      turn,
      uncertainAt: value.uncertainAt,
      reason: value.reason as SlackUncertainTurn["reason"],
      ...(sessionId ? { sessionId } : {}),
    };
  }
  return null;
}

function parseCompletedClaims(value: unknown): SlackCompletedEventClaim[] | null {
  if (!Array.isArray(value) || value.length > SLACK_EVENT_CLAIM_LIMIT) return null;
  const claims: SlackCompletedEventClaim[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.eventHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.eventHash) ||
      !isFiniteTimestamp(item.completedAt) ||
      !isBoundedString(item.claimId) ||
      !(UUID_V4_PATTERN.test(item.claimId) || /^legacy:[a-f0-9]{32}$/.test(item.claimId))
    ) {
      return null;
    }
    if (Object.keys(item).some((key) => !["eventHash", "completedAt", "claimId"].includes(key))) return null;
    if (item.claimId !== item.claimId.trim()) return null;
    if (seen.has(item.eventHash)) return null;
    seen.add(item.eventHash);
    claims.push({
      eventHash: item.eventHash,
      completedAt: item.completedAt,
      claimId: item.claimId,
    });
  }
  claims.sort((left, right) => left.completedAt - right.completedAt || left.eventHash.localeCompare(right.eventHash));
  return claims;
}

function legacyClaimId(eventHash: string): string {
  return `legacy:${eventHash.slice(0, 32)}`;
}

function parseLegacyAcceptedRun(value: unknown): SlackLegacyAcceptedRun | null | undefined {
  if (value === undefined) return undefined;
  if (isRecord(value) && Object.keys(value).some((key) =>
    !["sessionId", "runId", "retireAfter", "phase"].includes(key))) return null;
  if (
    !isRecord(value) ||
    !isBoundedString(value.sessionId) ||
    !isBoundedString(value.runId) ||
    !isFiniteTimestamp(value.retireAfter) ||
    (value.phase !== "accepted" && value.phase !== "uncertain")
  ) {
    return null;
  }
  if (value.sessionId !== value.sessionId.trim() || value.runId !== value.runId.trim()) return null;
  return {
    sessionId: value.sessionId,
    runId: value.runId,
    retireAfter: value.retireAfter,
    phase: value.phase,
  };
}

function parseLegacyClaims(value: unknown): SlackLegacyEventClaim[] | null | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > SLACK_EVENT_CLAIM_LIMIT) return null;
  const claims: SlackLegacyEventClaim[] = [];
  const seen = new Set<string>();
  for (const claim of value) {
    if (
      !isRecord(claim) ||
      typeof claim.eventHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(claim.eventHash)
    ) {
      return null;
    }
    if (Object.keys(claim).some((key) => key !== "eventHash")) return null;
    if (seen.has(claim.eventHash)) return null;
    seen.add(claim.eventHash);
    claims.push({ eventHash: claim.eventHash });
  }
  claims.sort((left, right) => left.eventHash.localeCompare(right.eventHash));
  return claims;
}

async function readLegacyDedupClaims(
  state: PluginStateClient,
  agentId: string,
): Promise<SlackLegacyEventClaim[]> {
  // Compatibility-only read for version-1 conversation records. Version-2
  // queues never use the old per-agent ledger for normal deduplication.
  const raw = await state.get(legacyDedupStateKey(agentId));
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) return [];
  if (Object.keys(raw).some((key) => !["version", "entries"].includes(key))) return [];
  if (raw.entries.length > SLACK_EVENT_CLAIM_LIMIT) {
    throw new Error("Legacy Slack event ledger exceeds the safe migration bound.");
  }
  const claims: SlackLegacyEventClaim[] = [];
  const seen = new Set<string>();
  for (const entry of raw.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.eventHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.eventHash) ||
      typeof entry.token !== "string" ||
      entry.token.length === 0 ||
      Object.keys(entry).some((key) => !["eventHash", "token", "expiresAt"].includes(key)) ||
      !isFiniteTimestamp(entry.expiresAt) ||
      seen.has(entry.eventHash)
    ) {
      continue;
    }
    seen.add(entry.eventHash);
    claims.push({ eventHash: entry.eventHash });
  }
  claims.sort((left, right) => left.eventHash.localeCompare(right.eventHash));
  return claims;
}

function parseLegacyState(value: unknown): LegacyStoredConversationSession | null {
  if (!isRecord(value) || value.version !== LEGACY_SESSION_STATE_VERSION || !isBoundedString(value.sessionId)) {
    return null;
  }
  if (Object.keys(value).some((key) => !["version", "sessionId", "retired", "acceptedRun"].includes(key))) {
    return null;
  }
  if (value.sessionId !== value.sessionId.trim()) return null;
  if (value.sessionId.length > SLACK_TURN_FIELD_MAX_LENGTH) return null;
  if (value.retired !== undefined && value.retired !== true) return null;
  if (value.retired === true && value.acceptedRun !== undefined) return null;
  if (value.acceptedRun !== undefined) {
    if (
      !isRecord(value.acceptedRun) ||
      Object.keys(value.acceptedRun).some((key) => !["runId", "retireAfter"].includes(key)) ||
      !isBoundedString(value.acceptedRun.runId) ||
      !isFiniteTimestamp(value.acceptedRun.retireAfter)
    ) {
      return null;
    }
    if (value.acceptedRun.runId !== value.acceptedRun.runId.trim()) return null;
    return {
      version: LEGACY_SESSION_STATE_VERSION,
      sessionId: value.sessionId,
      acceptedRun: {
        runId: value.acceptedRun.runId,
        retireAfter: value.acceptedRun.retireAfter,
      },
    };
  }
  return {
    version: LEGACY_SESSION_STATE_VERSION,
    sessionId: value.sessionId,
    ...(value.retired === true ? { retired: true as const } : {}),
  };
}

function parseState(
  value: unknown,
  companyId: string,
  conversationKey: string,
  fallbackConversation?: SlackConversationTarget,
): SlackConversationState | null {
  if (!isSlackConversationKey(conversationKey)) return null;
  if (value === null || value === undefined) {
    if (!fallbackConversation) return null;
    return emptyConversationState(companyId, fallbackConversation);
  }

  const legacy = parseLegacyState(value);
  if (legacy) {
    if (!fallbackConversation) {
      throw new Error("Legacy Slack conversation state requires a fresh webhook to recover its conversation target.");
    }
    return {
      version: SLACK_CONVERSATION_STATE_VERSION,
      companyId,
      conversation: fallbackConversation,
      owned: true,
      ...(!legacy.retired ? { sessionId: legacy.sessionId } : {}),
      pending: [],
      completed: [],
      ...(legacy.acceptedRun
        ? {
            legacyAcceptedRun: {
              sessionId: legacy.sessionId,
              runId: legacy.acceptedRun.runId,
              retireAfter: legacy.acceptedRun.retireAfter,
              phase: "accepted" as const,
            },
          }
        : {}),
    };
  }

  if (!isRecord(value) || value.version !== SLACK_CONVERSATION_STATE_VERSION) return null;
  if (Object.keys(value).some((key) =>
    ![
      "version",
      "companyId",
      "conversation",
      "owned",
      "sessionId",
      "pending",
      "active",
      "completed",
      "legacyAcceptedRun",
      "legacyClaims",
    ].includes(key))) return null;
  const conversation = parseConversation(value.conversation);
  const pending = Array.isArray(value.pending) ? value.pending.map(parseTurn) : null;
  const active = value.active === undefined ? undefined : parseActiveTurn(value.active);
  const completed = parseCompletedClaims(value.completed);
  const legacyAcceptedRun = parseLegacyAcceptedRun(value.legacyAcceptedRun);
  const legacyClaims = parseLegacyClaims(value.legacyClaims);
  const sessionId = value.sessionId === undefined
    ? undefined
    : isBoundedString(value.sessionId) ? value.sessionId : null;
  if (
    value.companyId !== companyId ||
    !conversation ||
    conversationHash(conversation) !== conversationKey ||
    typeof value.owned !== "boolean" ||
    !pending ||
    pending.some((turn) => turn === null) ||
    pending.length + (active ? 1 : 0) > SLACK_PENDING_TURN_LIMIT ||
    (value.active !== undefined && !active) ||
    !completed ||
    legacyAcceptedRun === null ||
    legacyClaims === null ||
    sessionId === null
  ) {
    return null;
  }
  const parsed: SlackConversationState = {
    version: SLACK_CONVERSATION_STATE_VERSION,
    companyId,
    conversation,
    owned: value.owned,
    ...(sessionId ? { sessionId } : {}),
    pending: pending as SlackQueuedTurn[],
    ...(active ? { active } : {}),
    completed,
    ...(legacyAcceptedRun ? { legacyAcceptedRun } : {}),
    ...(legacyClaims ? { legacyClaims } : {}),
  };
  if (!value.companyId || value.companyId !== value.companyId.trim() || value.companyId.length > SLACK_TURN_FIELD_MAX_LENGTH) {
    return null;
  }
  if (sessionId && sessionId.length > SLACK_TURN_FIELD_MAX_LENGTH) return null;
  const directConversation = conversation.channel.startsWith("D");
  if (directConversation && conversation.threadTs) return null;
  if (!directConversation && (pending.length > 0 || active) && !conversation.threadTs) return null;
  if (legacyAcceptedRun && !sessionId) return null;
  if (legacyAcceptedRun && legacyAcceptedRun.sessionId !== sessionId) return null;
  if (sessionId && !value.owned) return null;
  if (active && !value.owned) return null;
  if (pending.length > 0 && !value.owned) return null;
  if (legacyAcceptedRun && !value.owned) return null;
  if (active?.phase === "accepted" && active.retireAfter < active.acceptedAt) return null;
  if (active?.phase === "accepted" && active.acceptedAt < active.turn.enqueuedAt) return null;
  if (active?.phase === "active" && active.retireAfter < active.startedAt) return null;
  if (active?.phase === "active" && active.startedAt < active.turn.enqueuedAt) return null;
  if (active?.phase === "uncertain" && active.uncertainAt < active.turn.enqueuedAt) return null;
  const runtimeHashes = [
    ...parsed.pending.map((turn) => turn.eventHash),
    ...(parsed.active ? [parsed.active.turn.eventHash] : []),
    ...parsed.completed.map((claim) => claim.eventHash),
  ];
  if (new Set(runtimeHashes).size !== runtimeHashes.length) return null;
  if (
    legacyClaims?.some((claim) =>
      parsed.pending.some((turn) => turn.eventHash === claim.eventHash) ||
      parsed.completed.some((completed) => completed.eventHash === claim.eventHash))
  ) {
    return null;
  }
  if (legacyAcceptedRun && active) return null;
  if (legacyAcceptedRun && pending.length > 0) return null;
  if (legacyClaims && legacyClaims.length === 0) return null;
  if (legacyClaims && !legacyAcceptedRun && active) return null;
  if (legacyClaims && !legacyAcceptedRun && pending.length > 0) return null;
  if (legacyClaims && !sessionId) return null;
  if (active?.sessionId && sessionId && active.sessionId !== sessionId) return null;
  if (uniqueClaimCount(parsed) > SLACK_EVENT_CLAIM_LIMIT) return null;
  return parsed;
}

function conversationHash(conversation: SlackConversationTarget): string {
  return createHash("sha256")
    .update([
      conversation.teamId,
      conversation.appId,
      conversation.channel,
      conversation.threadTs ?? "",
    ].join("\0"), "utf8")
    .digest("hex");
}

export function isSlackConversationKey(value: string): boolean {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** Derives the stable, non-secret plugin-state key for one Slack conversation. */
export function slackConversationKey(conversation: SlackConversationTarget): string {
  if (!conversation || typeof conversation !== "object") {
    throw new Error("Slack conversation target contains an invalid or oversized field.");
  }
  const parsed = parseConversation(conversation);
  if (!parsed) throw new Error("Slack conversation target contains an invalid or oversized field.");
  return conversationHash(parsed);
}

/** Hashes a bounded Slack event ID for durable deduplication. */
export function slackEventHash(eventId: string): string {
  if (typeof eventId !== "string") throw new Error("Slack event ID is invalid.");
  const normalized = eventId.trim();
  if (!normalized || normalized !== eventId || normalized.length > SLACK_EVENT_ID_MAX_LENGTH) {
    throw new Error("Slack event ID is invalid.");
  }
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}


function slackConversationStateKey(
  agentId: string,
  conversationKey: string,
): SlackConversationStateKey {
  if (!isBoundedString(agentId) || agentId !== agentId.trim() || !isSlackConversationKey(conversationKey)) {
    throw new Error("Slack conversation state key is invalid.");
  }
  return {
    scopeKind: "agent" as const,
    scopeId: agentId,
    namespace: SLACK_CONVERSATION_STATE_NAMESPACE,
    stateKey: `${SLACK_CONVERSATION_STATE_KEY_PREFIX}${conversationKey}`,
  };
}

function legacyDedupStateKey(agentId: string) {
  if (!isBoundedString(agentId) || agentId !== agentId.trim()) {
    throw new Error("Slack legacy event-ledger agent ID is invalid.");
  }
  return {
    scopeKind: "agent" as const,
    scopeId: agentId,
    namespace: LEGACY_DEDUP_NAMESPACE,
    stateKey: LEGACY_DEDUP_STATE_KEY,
  };
}

function lockKey(input: SlackConversationReference): string {
  return `${input.companyId}:${input.agentId}:${input.conversationKey}`;
}

async function withConversationMutation<T>(
  input: SlackConversationReference,
  operation: () => Promise<T>,
): Promise<T> {
  if (!input.state || typeof operation !== "function") throw new Error("Slack queue mutation input is invalid.");
  if (typeof input.state.get !== "function" || typeof input.state.set !== "function") {
    throw new Error("Slack queue mutation state client is invalid.");
  }
  let tails = mutationTailsByState.get(input.state);
  if (!tails) {
    tails = new Map();
    mutationTailsByState.set(input.state, tails);
  }
  const key = lockKey(input);
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
    if (tails.get(key) === tail) {
      tails.delete(key);
      if (tails.size === 0) mutationTailsByState.delete(input.state);
    }
  }
}

function pruneCompletedClaims(state: SlackConversationState, nowMs: number): boolean {
  const cutoff = nowMs - SLACK_COMPLETED_EVENT_RETENTION_MS;
  const retained = state.completed.filter((claim) => claim.completedAt >= cutoff);
  retained.sort((left, right) => left.completedAt - right.completedAt || left.eventHash.localeCompare(right.eventHash));
  const reordered = retained.some((claim, index) =>
    claim.eventHash !== state.completed[index]?.eventHash ||
    claim.completedAt !== state.completed[index]?.completedAt);
  if (retained.length === state.completed.length && !reordered) return false;
  state.completed = retained;
  return true;
}

function hasSlackConversationEventHash(
  state: SlackConversationState,
  eventHash: string,
): boolean {
  return state.active?.turn.eventHash === eventHash ||
    state.pending.some((turn) => turn.eventHash === eventHash) ||
    state.completed.some((claim) => claim.eventHash === eventHash) ||
    Boolean(state.legacyClaims?.some((claim) => claim.eventHash === eventHash));
}

function uniqueClaimCount(state: SlackConversationState): number {
  return new Set([
    ...state.pending.map((turn) => turn.eventHash),
    ...(state.active ? [state.active.turn.eventHash] : []),
    ...state.completed.map((claim) => claim.eventHash),
    ...(state.legacyClaims?.map((claim) => claim.eventHash) ?? []),
  ]).size;
}

function activePendingCount(state: SlackConversationState): number {
  return state.pending.length + (state.active ? 1 : 0);
}

function assertStateBounds(state: SlackConversationState): void {
  if (state.version !== SLACK_CONVERSATION_STATE_VERSION) {
    throw new Error("Slack conversation queue state version is invalid.");
  }
  if (typeof state.owned !== "boolean") throw new Error("Slack conversation ownership state is invalid.");
  if (!parseConversation(state.conversation)) {
    throw new Error("Slack conversation queue state contains an invalid conversation target.");
  }
  if (!state.companyId || state.companyId !== state.companyId.trim() || state.companyId.length > SLACK_TURN_FIELD_MAX_LENGTH) {
    throw new Error("Slack conversation queue state contains invalid company scope.");
  }
  if (!state.owned && state.sessionId) throw new Error("Slack unowned conversation cannot retain a session.");
  if (!state.owned && (state.pending.length > 0 || state.active || state.legacyAcceptedRun)) {
    throw new Error("Slack unowned conversation cannot retain runnable work.");
  }
  if (activePendingCount(state) > SLACK_PENDING_TURN_LIMIT) {
    throw new Error("Slack conversation queue state exceeds its active/pending-turn limit.");
  }
  if (state.pending.some((turn) => !parseTurn(turn))) {
    throw new Error("Slack conversation queue state contains an invalid pending turn.");
  }
  if (state.active && !parseActiveTurn(state.active)) {
    throw new Error("Slack conversation queue state contains an invalid active turn.");
  }
  if (!parseCompletedClaims(state.completed)) {
    throw new Error("Slack conversation queue state contains invalid completed claims.");
  }
  if (state.legacyClaims && !parseLegacyClaims(state.legacyClaims)) {
    throw new Error("Slack conversation queue state contains invalid legacy claims.");
  }
  if (state.legacyAcceptedRun && !parseLegacyAcceptedRun(state.legacyAcceptedRun)) {
    throw new Error("Slack conversation queue state contains an invalid legacy run.");
  }
  if (uniqueClaimCount(state) > SLACK_EVENT_CLAIM_LIMIT) {
    throw new Error("Slack conversation queue state exceeds its event-claim limit.");
  }
  const runtimeHashes = [
    ...state.pending.map((turn) => turn.eventHash),
    ...(state.active ? [state.active.turn.eventHash] : []),
    ...state.completed.map((claim) => claim.eventHash),
  ];
  if (new Set(runtimeHashes).size !== runtimeHashes.length) {
    throw new Error("Slack conversation queue state contains duplicate event claims.");
  }
  if (state.active?.sessionId && state.sessionId && state.active.sessionId !== state.sessionId) {
    throw new Error("Slack conversation queue state contains conflicting session mappings.");
  }
  if (state.legacyAcceptedRun && state.sessionId !== state.legacyAcceptedRun.sessionId) {
    throw new Error("Slack legacy run session mapping is inconsistent.");
  }
}

async function loadState(input: SlackConversationReference): Promise<SlackConversationState> {
  if (!input.companyId || input.companyId !== input.companyId.trim()) {
    throw new Error("Slack conversation reference company scope is invalid.");
  }
  if (!input.agentId || input.agentId !== input.agentId.trim()) {
    throw new Error("Slack conversation reference agent ID is invalid.");
  }
  const raw = await input.state.get(slackConversationStateKey(input.agentId, input.conversationKey));
  let safeRaw = raw;
  if (raw !== null && raw !== undefined) {
    safeRaw = cloneQueueValue(raw);
  }
  const parsed = parseState(safeRaw, input.companyId, input.conversationKey, input.conversation);
  if (!parsed) {
    throw new Error("Slack conversation queue state is invalid; refusing unsafe session reuse.");
  }
  if (input.conversation) {
    const normalizedConversation = parseConversation(input.conversation);
    if (!normalizedConversation || conversationHash(normalizedConversation) !== input.conversationKey) {
      throw new Error("Slack conversation reference does not match its queue key.");
    }
  }
  return cloneQueueValue(parsed);
}

async function persistState(input: SlackConversationReference, state: SlackConversationState): Promise<void> {
  assertStateBounds(state);
  const serialized = cloneQueueValue(state);
  await input.state.set(slackConversationStateKey(input.agentId, input.conversationKey), serialized);
}

export async function readSlackConversationState(
  input: SlackConversationReference,
): Promise<SlackConversationState> {
  return withConversationMutation(input, () => loadState(input));
}

/** Returns a secret-free operational projection of one queue record. */
export async function getSlackConversationQueueSummary(
  input: {
    readonly state: PluginStateClient;
    readonly agentId: string;
    readonly companyId: string;
    readonly conversationKey: string;
  },
): Promise<SlackConversationQueueSummary> {
  if (!input || typeof input !== "object" || !input.state) throw new Error("Slack queue summary input is invalid.");
  if (typeof input.state.get !== "function") throw new Error("Slack queue summary state client is invalid.");
  if (!input.companyId.trim() || input.companyId !== input.companyId.trim()) {
    throw new Error("Slack queue summary requires valid company scope.");
  }
  const state = await readSlackConversationState(input);
  const activePhase: SlackConversationQueueStatus | undefined = state.active?.phase ??
    (state.legacyAcceptedRun ? state.legacyAcceptedRun.phase : undefined);
  const status: SlackConversationQueueStatus = activePhase ?? (state.pending.length > 0 ? "queued" : "idle");
  return {
    version: SLACK_CONVERSATION_STATE_VERSION,
    status,
    pendingCount: state.pending.length,
    hasSession: Boolean(state.sessionId),
    completedCount: state.completed.length,
    atCapacity: activePendingCount(state) >= SLACK_PENDING_TURN_LIMIT ||
      uniqueClaimCount(state) >= SLACK_EVENT_CLAIM_LIMIT,
  };
}

/** Reports whether a persisted queue needs a fresh self-event kick. */
export async function shouldKickSlackConversationQueue(
  input: Parameters<typeof getSlackConversationQueueSummary>[0],
): Promise<boolean> {
  return (await getSlackConversationQueueSummary(input)).status === "queued";
}

export async function mutateSlackConversationState<T>(
  input: SlackConversationReference,
  operation: (state: SlackConversationState) => ConversationMutation<T>,
  nowMs = queueNowMs(),
): Promise<T> {
  if (!isFiniteTimestamp(nowMs)) throw new Error("Slack queue mutation timestamp is invalid.");
  return withConversationMutation(input, async () => {
    const state = await loadState(input);
    const pruned = pruneCompletedClaims(state, nowMs);
    const mutation = operation(state);
    if (pruned || mutation.changed) await persistState(input, state);
    return mutation.result;
  });
}

export function completeSlackTurnClaim(
  state: SlackConversationState,
  turn: SlackQueuedTurn,
  completedAt = queueNowMs(),
): void {
  if (!isFiniteTimestamp(completedAt)) throw new Error("Slack completion timestamp is invalid.");
  if (!state.completed.some((claim) => claim.eventHash === turn.eventHash)) {
    state.completed.push({ eventHash: turn.eventHash, completedAt, claimId: turn.claimId });
  }
}

export function createSlackActiveTurn(turn: SlackQueuedTurn, retireAfter: number, nowMs = queueNowMs()): SlackStartingTurn {
  if (!isFiniteTimestamp(retireAfter) || !isFiniteTimestamp(nowMs) || retireAfter <= nowMs) {
    throw new Error("Slack active-turn lease is invalid.");
  }
  const attemptId = randomUUID();
  if (!UUID_V4_PATTERN.test(attemptId)) {
    throw new Error("Slack active-turn token generation failed.");
  }
  return {
    phase: "active",
    attemptId,
    turn,
    startedAt: nowMs,
    retireAfter,
  };
}

/** Validates, bounds, deduplicates, and durably appends one Slack turn. */
export async function enqueueSlackConversationTurn(
  input: EnqueueSlackConversationTurnInput,
): Promise<EnqueueSlackConversationTurnResult> {
  if (!input || typeof input !== "object" || !input.state) {
    throw new Error("Slack queue input is invalid.");
  }
  if (typeof input.state.get !== "function" || typeof input.state.set !== "function") {
    throw new Error("Slack queue state client is invalid.");
  }
  const nowMs = input.nowMs ?? queueNowMs();
  if (!isFiniteTimestamp(nowMs)) throw new Error("Slack queue timestamp is invalid.");
  const conversation = parseConversation(input.conversation);
  const event = parseTurnEvent(input.event);
  const normalizedEventId = input.eventId.trim();
  const normalizedAgentId = input.agentId.trim();
  const normalizedCompanyId = input.companyId.trim();
  if (
    !conversation ||
    !event ||
    !normalizedEventId ||
    !isBoundedString(normalizedAgentId) ||
    normalizedAgentId !== input.agentId ||
    !isBoundedString(normalizedCompanyId) ||
    normalizedCompanyId !== input.companyId
  ) {
    throw new Error("Slack turn contains a missing, invalid, or oversized required field.");
  }
  if (!["direct", "mention", "broadcast", "owned-reply"].includes(input.startMode)) {
    throw new Error("Slack turn start mode is invalid.");
  }
  const startsConversation = input.startMode !== "owned-reply";
  if (input.event.channel !== input.conversation.channel) {
    throw new Error("Slack turn event channel does not match its conversation key.");
  }
  if (!/^[CDG][A-Za-z0-9-]{2,}$/.test(input.event.channel)) {
    throw new Error("Slack queued turn has an invalid conversation ID.");
  }
  if (!input.event.user || !/^[UW][A-Za-z0-9-]{2,}$/.test(input.event.user)) {
    throw new Error("Slack queued turn has an invalid user ID.");
  }
  if (input.event.user.length > SLACK_TURN_FIELD_MAX_LENGTH) {
    throw new Error("Slack queued turn user ID exceeds the safe persistence bound.");
  }
  if (input.startMode === "direct" && !input.conversation.channel.startsWith("D")) {
    throw new Error("Slack direct turn must target a direct-message conversation.");
  }
  if (input.startMode === "direct" && input.event.channelType !== "im") {
    throw new Error("Slack direct turn must carry channel type im.");
  }
  if (input.startMode === "direct" && input.event.threadTs && !input.event.ts) {
    throw new Error("Slack threaded direct-message turn requires a message timestamp.");
  }
  if (input.startMode !== "direct" && input.conversation.channel.startsWith("D")) {
    throw new Error("Slack non-direct turn cannot target a direct-message conversation.");
  }
  if (input.startMode !== "direct" && !["channel", "group", "mpim"].includes(input.event.channelType ?? "")) {
    throw new Error("Slack non-direct turn has an invalid channel type.");
  }
  if (input.startMode === "owned-reply" && !input.conversation.threadTs) {
    throw new Error("Slack owned reply must target an existing thread.");
  }
  if (input.startMode === "owned-reply" && !input.event.ts) {
    throw new Error("Slack owned reply requires a message timestamp.");
  }
  if (input.startMode === "owned-reply" && input.event.threadTs !== input.conversation.threadTs) {
    throw new Error("Slack owned reply does not match its thread root.");
  }
  if ((input.startMode === "mention" || input.startMode === "broadcast") && !input.conversation.threadTs) {
    throw new Error("Slack channel conversation starter must establish a thread root.");
  }
  if ((input.startMode === "mention" || input.startMode === "broadcast") &&
    input.event.ts && input.conversation.threadTs !== (input.event.threadTs ?? input.event.ts)) {
    throw new Error("Slack channel starter does not match its thread root.");
  }
  if (input.startMode === "mention" && input.event.type !== "app_mention") {
    throw new Error("Slack mention turn must carry an app_mention event.");
  }
  if (input.startMode === "mention" && !input.event.ts) {
    throw new Error("Slack mention turn requires a message timestamp.");
  }
  if (input.startMode === "mention" && input.event.channelType === "im") {
    throw new Error("Slack channel mention cannot use direct-message channel type.");
  }
  if (input.startMode === "broadcast" && input.event.type !== "message") {
    throw new Error("Slack broadcast turn must carry a message event.");
  }
  if (input.startMode === "broadcast" && !input.event.ts) {
    throw new Error("Slack broadcast turn requires a message timestamp.");
  }
  if (input.startMode === "broadcast" && !/<!(?:channel|here|everyone)(?:\|[^>]*)?>/.test(input.event.text ?? "")) {
    throw new Error("Slack broadcast turn has no broadcast token.");
  }
  if (input.startMode === "direct" && !input.event.ts && input.event.threadTs) {
    throw new Error("Slack threaded direct-message turn requires its own message timestamp.");
  }
  if (input.startMode === "direct" && input.event.ts && !SLACK_MESSAGE_TS_PATTERN.test(input.event.ts)) {
    throw new Error("Slack direct-message turn has an invalid message timestamp.");
  }
  if (input.startMode === "owned-reply" && input.event.ts === input.event.threadTs) {
    throw new Error("Slack owned reply timestamp cannot equal its thread root.");
  }
  if (!input.event.text?.trim()) throw new Error("Slack queued turn requires nonblank message text.");
  if (input.event.text.length > SLACK_TURN_TEXT_MAX_LENGTH) {
    throw new Error("Slack queued turn text exceeds the safe persistence bound.");
  }
  if (Buffer.byteLength(input.event.text, "utf8") > SLACK_TURN_TEXT_MAX_BYTES) {
    throw new Error("Slack queued turn text exceeds the safe byte bound.");
  }
  if (input.event.ts && !SLACK_MESSAGE_TS_PATTERN.test(input.event.ts)) {
    throw new Error("Slack queued turn has an invalid message timestamp.");
  }
  if (input.event.threadTs && !SLACK_MESSAGE_TS_PATTERN.test(input.event.threadTs)) {
    throw new Error("Slack queued turn has an invalid thread timestamp.");
  }
  if ((input.startMode === "direct" || input.startMode === "broadcast" || input.startMode === "owned-reply") && input.event.type !== "message") {
    throw new Error("Slack message turn has an unexpected event type.");
  }
  if (input.startMode === "direct" && input.conversation.threadTs) {
    throw new Error("Slack direct-message queue key must not include a thread ID.");
  }
  if (
    input.conversation.threadTs &&
    input.event.threadTs !== input.conversation.threadTs &&
    input.event.ts !== input.conversation.threadTs
  ) {
    throw new Error("Slack turn event thread does not match its conversation key.");
  }
  const conversationKey = conversationHash(conversation);
  const eventHash = slackEventHash(input.eventId);
  const claimId = randomUUID();
  if (!UUID_V4_PATTERN.test(claimId)) {
    throw new Error("Slack queue claim token generation failed.");
  }
  const turn: SlackQueuedTurn = {
    claimId,
    eventId: normalizedEventId,
    eventHash,
    enqueuedAt: nowMs,
    event,
  };
  const reference: SlackConversationReference = {
    state: input.state,
    agentId: normalizedAgentId,
    companyId: normalizedCompanyId,
    conversationKey,
    conversation,
  };
  const rawConversationState = await input.state.get(slackConversationStateKey(normalizedAgentId, conversationKey));
  const legacyConversation = rawConversationState !== null &&
    rawConversationState !== undefined &&
    parseLegacyState(rawConversationState) !== null;
  const legacyClaims = legacyConversation
    ? await readLegacyDedupClaims(input.state, normalizedAgentId)
    : [];
  const legacySnapshot = legacyConversation ? parseLegacyState(rawConversationState) : null;
  if (legacyConversation && !legacySnapshot) {
    throw new SlackConversationStateConflictError(
      "Slack legacy conversation state changed during migration; retry the delivery.",
    );
  }

  let hadExistingClaim = false;
  let importedMatchingLegacyClaim = false;
  const result = await mutateSlackConversationState<EnqueueSlackConversationTurnResult>(reference, (state) => {
    if (
      legacySnapshot &&
      (state.sessionId !== (legacySnapshot.retired ? undefined : legacySnapshot.sessionId) ||
        state.legacyAcceptedRun?.runId !== legacySnapshot.acceptedRun?.runId)
    ) {
      throw new SlackConversationStateConflictError(
        "Slack conversation queue changed during legacy migration; retry the delivery.",
      );
    }
    let importedLegacyClaims = false;
    if (legacyConversation && !state.legacyClaims && legacyClaims.length > 0) {
      if (state.legacyAcceptedRun) {
        state.legacyClaims = legacyClaims;
      } else {
        if (uniqueClaimCount(state) + legacyClaims.length > SLACK_EVENT_CLAIM_LIMIT) {
          throw new SlackConversationQueueFullError(
            "Migrated Slack event ledger exceeds the safe conversation bound.",
          );
        }
        state.completed.push(...legacyClaims.map((claim) => ({
          eventHash: claim.eventHash,
          completedAt: nowMs,
          claimId: legacyClaimId(claim.eventHash),
        })));
      }
      importedLegacyClaims = true;
    }
    if (legacyConversation && state.legacyAcceptedRun && !state.legacyClaims && legacyClaims.length === 0) {
      // A v1 accepted run cannot be rebound to its callback after restart. If
      // its old per-agent ledger is gone, conservatively treat this delivery
      // as that uncertain run rather than risk sending it twice. The kick can
      // then retire the lease under fresh scope.
      state.legacyClaims = [{ eventHash }];
      importedLegacyClaims = true;
    }
    if (hasSlackConversationEventHash(state, eventHash)) {
      hadExistingClaim = true;
      importedMatchingLegacyClaim = importedLegacyClaims &&
        (Boolean(state.legacyClaims?.some((claim) => claim.eventHash === eventHash)) ||
          state.completed.some((claim) => claim.eventHash === eventHash));
      const ownershipChanged = startsConversation && !state.owned;
      if (ownershipChanged) state.owned = true;
      return {
        result: { status: "duplicate" as const, conversationKey },
        changed: importedLegacyClaims || ownershipChanged,
      };
    }
    if (uniqueClaimCount(state) >= SLACK_EVENT_CLAIM_LIMIT) {
      throw new SlackConversationQueueFullError(
        "Slack conversation event ledger is full; retry after retained completions expire.",
      );
    }
    if (!startsConversation && !state.owned) {
      state.completed.push({ eventHash, completedAt: nowMs, claimId: turn.claimId });
      return {
        result: { status: "ignored" as const, conversationKey },
        changed: true,
      };
    }
    const queuedCount = activePendingCount(state);
    if (queuedCount >= SLACK_PENDING_TURN_LIMIT) {
      throw new SlackConversationQueueFullError("Slack conversation queue is full; retry the delivery later.");
    }
    if (startsConversation) state.owned = true;
    state.pending.push(turn);
    return {
      result: { status: "enqueued" as const, conversationKey },
      changed: true,
    };
  }, nowMs);
  if (!result || result.conversationKey !== conversationKey) {
    throw new SlackConversationStateConflictError("Slack enqueue result changed before confirmation.");
  }
  if (result.status !== "enqueued" && result.status !== "duplicate" && result.status !== "ignored") {
    throw new SlackConversationStateConflictError("Slack enqueue result status is invalid.");
  }

  // The state API is last-write-wins. Confirm this claim still owns the hash
  // before allowing webhook scope to emit its drain event and acknowledge.
  if (result.status !== "duplicate" || importedMatchingLegacyClaim || hadExistingClaim) {
    const confirmed = await readSlackConversationState(reference);
    const confirmedTurn = confirmed.active?.turn.eventHash === eventHash
      ? confirmed.active.turn
      : confirmed.pending.find((queued) => queued.eventHash === eventHash);
    if (result.status === "enqueued" && confirmedTurn?.claimId !== turn.claimId) {
      throw new SlackConversationStateConflictError();
    }
    if (
      result.status === "ignored" &&
      !confirmed.completed.some((claim) => claim.eventHash === eventHash && claim.claimId === turn.claimId)
    ) {
      throw new SlackConversationStateConflictError();
    }
    if (
      importedMatchingLegacyClaim &&
      !hasSlackConversationEventHash(confirmed, eventHash)
    ) {
      throw new SlackConversationStateConflictError();
    }
    if (hadExistingClaim && !hasSlackConversationEventHash(confirmed, eventHash)) {
      throw new SlackConversationStateConflictError();
    }
  }
  return result;
}

export function isMissingAgentSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.trim();
  return /^Session not found(?: or closed)?:\s+\S+/i.test(message) && message.length <= 512;
}
