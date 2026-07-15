import { createHash, randomUUID } from "node:crypto";

export interface SlackDedupStateClient {
  get(key: { scopeKind: "agent"; scopeId: string; namespace?: string; stateKey: string }): Promise<unknown>;
  set(
    key: { scopeKind: "agent"; scopeId: string; namespace?: string; stateKey: string },
    value: unknown,
  ): Promise<void>;
  delete(key: { scopeKind: "agent"; scopeId: string; namespace?: string; stateKey: string }): Promise<void>;
}

export const SLACK_EVENT_DEDUP_TTL_MS = 10 * 60 * 1_000;

const DEDUP_NAMESPACE = "slack-ingress";
const DEDUP_STATE_KEY = "event-ledger";
const DEDUP_LEDGER_VERSION = 1 as const;

interface StoredClaim {
  readonly eventHash: string;
  readonly token: string;
  readonly expiresAt: number;
}

interface StoredLedger {
  readonly version: typeof DEDUP_LEDGER_VERSION;
  readonly entries: readonly StoredClaim[];
}

interface ProcessingClaim {
  readonly token: string;
  readonly outcome: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

interface ClientBookkeeping {
  readonly inFlightByAgent: Map<string, Map<string, ProcessingClaim>>;
  readonly mutationTails: Map<string, Promise<void>>;
}

// The SDK state API exposes get/set/delete, but no compare-and-set or
// conditional insert. The persistent token write/read-back below detects
// overlapping writers whose writes both land before either confirmation,
// but it is not atomic: a second process can still overwrite a claim after
// the first process confirms ownership, allowing both to proceed. Exactly
// once cross-process execution therefore remains a platform limitation. A
// multi-worker deployment needs an SDK CAS/conditional-insert primitive (or
// another shared atomic store) before it can claim exactly-once processing.
//
// Within one worker, PluginContext supplies one stable state client. The
// WeakMap keeps concurrent duplicates for that client attached to the
// original delivery until processing completes: successful processing makes
// waiters resolve as duplicates, while failed processing makes every waiter
// reject with the same failure so the host does not acknowledge any copy.
const bookkeepingByClient = new WeakMap<SlackDedupStateClient, ClientBookkeeping>();

function bookkeepingFor(state: SlackDedupStateClient): ClientBookkeeping {
  const existing = bookkeepingByClient.get(state);
  if (existing) return existing;
  const created: ClientBookkeeping = {
    inFlightByAgent: new Map(),
    mutationTails: new Map(),
  };
  bookkeepingByClient.set(state, created);
  return created;
}

function hashEventId(eventId: string): string {
  return createHash("sha256").update(eventId, "utf8").digest("hex");
}

function stateKey(agentId: string) {
  return {
    scopeKind: "agent" as const,
    scopeId: agentId,
    namespace: DEDUP_NAMESPACE,
    stateKey: DEDUP_STATE_KEY,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLedger(raw: unknown): StoredLedger {
  if (!isRecord(raw) || raw.version !== DEDUP_LEDGER_VERSION || !Array.isArray(raw.entries)) {
    return { version: DEDUP_LEDGER_VERSION, entries: [] };
  }

  const entries: StoredClaim[] = [];
  for (const rawEntry of raw.entries) {
    if (!isRecord(rawEntry)) continue;
    const { eventHash, token, expiresAt } = rawEntry;
    if (
      typeof eventHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(eventHash) ||
      typeof token !== "string" ||
      token.length === 0 ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt)
    ) {
      continue;
    }
    entries.push({ eventHash, token, expiresAt });
  }
  return { version: DEDUP_LEDGER_VERSION, entries };
}

async function persistLedger(
  state: SlackDedupStateClient,
  agentId: string,
  entries: readonly StoredClaim[],
): Promise<void> {
  if (entries.length === 0) {
    await state.delete(stateKey(agentId));
    return;
  }
  await state.set(stateKey(agentId), { version: DEDUP_LEDGER_VERSION, entries });
}

async function withAgentMutation<T>(
  state: SlackDedupStateClient,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const bookkeeping = bookkeepingFor(state);
  const previous = bookkeeping.mutationTails.get(agentId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  bookkeeping.mutationTails.set(agentId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (bookkeeping.mutationTails.get(agentId) === tail) {
      bookkeeping.mutationTails.delete(agentId);
    }
  }
}

function localClaimsFor(
  state: SlackDedupStateClient,
  agentId: string,
  create: boolean,
): Map<string, ProcessingClaim> | undefined {
  const bookkeeping = bookkeepingFor(state);
  const existing = bookkeeping.inFlightByAgent.get(agentId);
  if (existing || !create) return existing;
  const created = new Map<string, ProcessingClaim>();
  bookkeeping.inFlightByAgent.set(agentId, created);
  return created;
}

function removeLocalClaim(
  state: SlackDedupStateClient,
  agentId: string,
  eventHash: string,
  claim: ProcessingClaim,
): void {
  const bookkeeping = bookkeepingFor(state);
  const claims = bookkeeping.inFlightByAgent.get(agentId);
  if (!claims || claims.get(eventHash) !== claim) return;
  claims.delete(eventHash);
  if (claims.size === 0) bookkeeping.inFlightByAgent.delete(agentId);
}

function createProcessingClaim(): ProcessingClaim {
  let resolveOutcome!: () => void;
  let rejectOutcome!: (reason: unknown) => void;
  const outcome = new Promise<void>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  // The original delivery owns processing and does not await this promise;
  // attach a rejection observer so a failure with no duplicate waiter does
  // not become an unhandled rejection.
  void outcome.catch(() => undefined);
  return {
    token: randomUUID(),
    outcome,
    resolve: resolveOutcome,
    reject: rejectOutcome,
  };
}

/**
 * Claims a Slack event for processing. A true result remains locally
 * in-flight until the caller invokes completeSlackEventClaim or
 * releaseSlackEventClaim. Concurrent duplicates on the same state client
 * await that processing outcome instead of being acknowledged early.
 */
export async function shouldProcessSlackEvent(
  state: SlackDedupStateClient,
  agentId: string,
  eventId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  const eventHash = hashEventId(eventId);
  const localClaims = localClaimsFor(state, agentId, true)!;
  const existingLocalClaim = localClaims.get(eventHash);
  if (existingLocalClaim) {
    await existingLocalClaim.outcome;
    return false;
  }

  const claim = createProcessingClaim();
  localClaims.set(eventHash, claim);

  try {
    const ownsPersistentClaim = await withAgentMutation(state, agentId, async () => {
      const ledger = parseLedger(await state.get(stateKey(agentId)));
      const liveEntries = ledger.entries.filter((entry) => entry.expiresAt > nowMs);
      const existingPersistentClaim = liveEntries.find((entry) => entry.eventHash === eventHash);

      if (existingPersistentClaim) {
        if (liveEntries.length !== ledger.entries.length) {
          await persistLedger(state, agentId, liveEntries);
        }
        return false;
      }

      const nextEntries: StoredClaim[] = [
        ...liveEntries,
        { eventHash, token: claim.token, expiresAt: nowMs + SLACK_EVENT_DEDUP_TTL_MS },
      ];
      await persistLedger(state, agentId, nextEntries);

      // Best-effort ownership election for overlapping clients/processes.
      // This detects a competing write that landed before confirmation, but
      // cannot prevent a later overwrite without SDK-level CAS support.
      const confirmed = parseLedger(await state.get(stateKey(agentId)));
      const confirmedClaim = confirmed.entries.find(
        (entry) => entry.eventHash === eventHash && entry.expiresAt > nowMs,
      );
      if (!confirmedClaim) {
        // A last-write-wins state race can remove this unique event while a
        // different event is claimed by another worker. It is not a
        // duplicate: fail retryably so the host does not acknowledge work
        // that no worker owns.
        throw new Error("Slack event deduplication state conflict; retry the delivery");
      }
      return confirmedClaim.token === claim.token;
    });

    if (!ownsPersistentClaim) {
      removeLocalClaim(state, agentId, eventHash, claim);
      claim.resolve();
      return false;
    }

    return true;
  } catch (error) {
    removeLocalClaim(state, agentId, eventHash, claim);
    claim.reject(error);
    throw error;
  }
}

/** Marks a successfully processed claim complete and releases local waiters. */
export async function completeSlackEventClaim(
  state: SlackDedupStateClient,
  agentId: string,
  eventId: string,
): Promise<void> {
  const eventHash = hashEventId(eventId);
  const claim = localClaimsFor(state, agentId, false)?.get(eventHash);
  if (!claim) return;
  removeLocalClaim(state, agentId, eventHash, claim);
  claim.resolve();
}

/**
 * Releases a failed claim for retry. Only the caller's unique persistent
 * token is removed, so a stale failure cannot delete a newer worker's claim.
 * Any local duplicate waiters receive the same processing failure.
 */
export async function releaseSlackEventClaim(
  state: SlackDedupStateClient,
  agentId: string,
  eventId: string,
  reason: unknown = new Error("Slack event processing failed"),
): Promise<void> {
  const eventHash = hashEventId(eventId);
  const claim = localClaimsFor(state, agentId, false)?.get(eventHash);
  if (!claim) return;

  try {
    await withAgentMutation(state, agentId, async () => {
      const ledger = parseLedger(await state.get(stateKey(agentId)));
      const retainedEntries = ledger.entries.filter(
        (entry) => !(entry.eventHash === eventHash && entry.token === claim.token),
      );
      if (retainedEntries.length !== ledger.entries.length) {
        await persistLedger(state, agentId, retainedEntries);
      }
    });
  } finally {
    removeLocalClaim(state, agentId, eventHash, claim);
    claim.reject(reason);
  }
}
