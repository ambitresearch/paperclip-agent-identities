import { createHash } from "node:crypto";
import type {
  AgentSession,
  PluginAgentSessionsClient,
  PluginStateClient,
} from "@paperclipai/plugin-sdk";

const SESSION_NAMESPACE = "slack-conversations";
const SESSION_STATE_VERSION = 1 as const;

interface StoredConversationSession {
  readonly version: typeof SESSION_STATE_VERSION;
  readonly sessionId: string;
}

export interface SlackConversationTarget {
  readonly teamId: string;
  readonly appId: string;
  readonly channel: string;
  readonly threadTs?: string;
}

interface ConversationSessionInput {
  readonly state: PluginStateClient;
  readonly sessions: PluginAgentSessionsClient;
  readonly agentId: string;
  readonly companyId: string;
  readonly conversation: SlackConversationTarget;
}

const mutationTailsByState = new WeakMap<PluginStateClient, Map<string, Promise<void>>>();

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

function conversationStateKey(agentId: string, conversation: SlackConversationTarget) {
  return {
    scopeKind: "agent" as const,
    scopeId: agentId,
    namespace: SESSION_NAMESPACE,
    stateKey: `session:${conversationHash(conversation)}`,
  };
}

function parseStoredSession(value: unknown): StoredConversationSession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== SESSION_STATE_VERSION ||
    typeof record.sessionId !== "string" ||
    record.sessionId.trim().length === 0
  ) {
    return null;
  }
  return { version: SESSION_STATE_VERSION, sessionId: record.sessionId };
}

async function withConversationMutation<T>(
  state: PluginStateClient,
  lockKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  let tails = mutationTailsByState.get(state);
  if (!tails) {
    tails = new Map();
    mutationTailsByState.set(state, tails);
  }

  const previous = tails.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  tails.set(lockKey, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(lockKey) === tail) tails.delete(lockKey);
  }
}

async function loadActiveConversationSession(
  input: ConversationSessionInput,
  stateKey: ReturnType<typeof conversationStateKey>,
): Promise<AgentSession | null> {
  const stored = parseStoredSession(await input.state.get(stateKey));
  if (!stored) return null;

  const activeSessions = await input.sessions.list(input.agentId, input.companyId);
  const active = activeSessions.find((session) => session.sessionId === stored.sessionId);
  if (active) return active;

  await input.state.delete(stateKey);
  return null;
}

export function withSlackConversationTurn<T>(
  input: ConversationSessionInput,
  operation: () => Promise<T>,
  completion?: Promise<unknown>,
): Promise<T> {
  const stateKey = conversationStateKey(input.agentId, input.conversation);
  const lockKey = `${input.agentId}:${stateKey.stateKey}`;
  let tails = mutationTailsByState.get(input.state);
  if (!tails) {
    tails = new Map();
    mutationTailsByState.set(input.state, tails);
  }

  const previous = tails.get(lockKey) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    async () => {
      await completion;
    },
    () => undefined,
  );
  tails.set(lockKey, tail);
  void tail.then(() => {
    if (tails?.get(lockKey) === tail) tails.delete(lockKey);
  });
  return result;
}

/**
 * Returns the active session only when this agent already owns the Slack
 * conversation. This is the fail-closed gate for plain channel-thread
 * replies, which must never create a new conversation without an app mention.
 */
export async function getExistingSlackConversationSession(
  input: ConversationSessionInput,
): Promise<AgentSession | null> {
  const stateKey = conversationStateKey(input.agentId, input.conversation);
  const lockKey = `${input.agentId}:${stateKey.stateKey}`;
  return withConversationMutation(input.state, lockKey, () =>
    loadActiveConversationSession(input, stateKey));
}

/**
 * Returns one durable Paperclip agent session for one Slack conversation.
 *
 * A DM is one conversation across top-level and threaded replies because its
 * caller omits `threadTs`. Group and channel threads are separate conversations
 * keyed by their root `thread_ts`. The mapping lives in plugin state so it
 * survives worker reloads, while `sessions.list` verifies that a saved session
 * still exists and still belongs to the routed agent.
 */
export async function getOrCreateSlackConversationSession(
  input: ConversationSessionInput,
): Promise<AgentSession> {
  const stateKey = conversationStateKey(input.agentId, input.conversation);
  const lockKey = `${input.agentId}:${stateKey.stateKey}`;

  return withConversationMutation(input.state, lockKey, async () => {
    const active = await loadActiveConversationSession(input, stateKey);
    if (active) return active;

    const created = await input.sessions.create(input.agentId, input.companyId);
    try {
      await input.state.set(stateKey, {
        version: SESSION_STATE_VERSION,
        sessionId: created.sessionId,
      });
    } catch (error) {
      await input.sessions.close(created.sessionId, input.companyId).catch(() => undefined);
      throw error;
    }
    return created;
  });
}

/** Clears a stale mapping only when it still points at the failed session. */
export async function forgetSlackConversationSession(
  input: ConversationSessionInput,
  sessionId: string,
): Promise<void> {
  const stateKey = conversationStateKey(input.agentId, input.conversation);
  const lockKey = `${input.agentId}:${stateKey.stateKey}`;
  await withConversationMutation(input.state, lockKey, async () => {
    const stored = parseStoredSession(await input.state.get(stateKey));
    if (stored?.sessionId === sessionId) await input.state.delete(stateKey);
  });
}

export function isMissingAgentSessionError(error: unknown): boolean {
  return error instanceof Error && /^Session not found:/i.test(error.message);
}
