/**
 * DRO-1258: liveness/completion evidence for a routed Slack turn.
 *
 * A Slack-initiated action request could previously end as a clean success
 * when the run produced no action at all. Two false-positive signals fed the
 * same defect:
 *
 *  - `tool_gateway.session_created` was treated as productive progress. It
 *    proves only that a gateway session was *attached*; it says nothing about
 *    whether any tool was ever invoked through it.
 *  - A plugin invocation whose terminal classification is `plan_only` was
 *    recorded as terminal success even though `plan_only` explicitly means
 *    runnable future work was described but not executed.
 *
 * This module keeps that judgement in one pure, independently testable place.
 * It observes the same structured adapter records the reply accumulator
 * already parses and answers one question: did this run produce durable
 * action evidence, or did it only acknowledge, promise, or plan?
 *
 * Deliberate non-goals: this does not decide *what* to do about a non-acting
 * run (that is the caller's bounded continuation/recovery path), and it never
 * inspects secrets, tokens, or Slack message bodies beyond the final reply
 * text it is explicitly handed.
 */

/** Attachment telemetry that must never be counted as productive progress. */
export const GATEWAY_ATTACHMENT_EVENT = "tool_gateway.session_created";

/**
 * Terminal classification meaning "described runnable future work without
 * executing it". Never a terminal success.
 */
export const PLAN_ONLY_CLASSIFICATION = "plan_only";

export type SlackRunOutcome =
  /** Durable tool/action evidence, or a substantive non-action answer. */
  | "acted"
  /** The reply only acknowledges the request or promises future work. */
  | "acknowledgment_only"
  /** Terminal classification was `plan_only`: runnable work, no execution. */
  | "plan_only";

export interface SlackRunEvidence {
  /** A real tool/command/file-change invocation was observed. */
  readonly durableAction: boolean;
  /** A gateway session was attached. Telemetry only -- never progress. */
  readonly gatewayAttached: boolean;
  /** A terminal record classified this invocation `plan_only`. */
  readonly planOnly: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Record `type` values that prove a tool or command actually ran. Kept as an
 * explicit allowlist: an unknown record type must never be optimistically
 * read as action evidence, because that is exactly the false-success failure
 * mode this module exists to prevent.
 */
const TOOL_INVOCATION_RECORD_TYPES: ReadonlySet<string> = new Set([
  "acpx.tool_call",
  "acpx.tool_result",
  "tool_use",
  "tool_result",
  "tool_call",
  "function_call",
  "function_call_output",
]);

/**
 * `item.completed` item types that prove execution rather than description.
 * `agent_message` is intentionally absent: prose is not action evidence.
 */
const TOOL_INVOCATION_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "tool_call",
  "function_call",
  "file_change",
  "patch_apply",
  "local_shell_call",
  "mcp_tool_call",
]);

/** Terminal records that may carry an invocation's classification. */
const TERMINAL_RECORD_TYPES: ReadonlySet<string> = new Set([
  "result",
  "item.completed",
  "invocation.completed",
  "turn.completed",
  "acpx.result",
]);

function readClassification(record: Record<string, unknown>): string | null {
  for (const key of ["classification", "terminalClassification", "outcome"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function messageContentHasToolUse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      isRecord(part) &&
      typeof part.type === "string" &&
      TOOL_INVOCATION_RECORD_TYPES.has(part.type),
  );
}

/**
 * Phrases that mark a clause as an acknowledgment of, or a promise about,
 * work that has not happened yet. Present/future intent only -- past-tense
 * report phrasing ("I posted", "created the PR") is deliberately excluded.
 */
const PROMISE_PATTERNS: readonly RegExp[] = [
  /\bi(?:'| a)?m (?:going to|about to|now )?(?:start|starting|work|working|look|looking|check|checking)\b/i,
  /\bi(?:'|\u2019)?ll\b/i,
  /\bi will\b/i,
  /\bi(?:'|\u2019)?m on it\b/i,
  /\bon it\b/i,
  /\blet me (?:go |just )?(?:check|look|start|take|get|see|dig|run|do)\b/i,
  /\bgive me a (?:sec|second|minute|moment)\b/i,
  /\bwill (?:now |then )?(?:start|begin|do|run|handle|take care of|get to|look into|proceed)\b/i,
  /\bgoing to (?:start|begin|do|run|handle|look|check|proceed|work)\b/i,
  /\bstarting (?:on|to|work|now)\b/i,
  /\bworking on (?:it|this|that)\b/i,
  /\b(?:sounds good|got it|sure thing|will do|understood|acknowledged|roger|okay|ok|sure|absolutely|no problem)\b/i,
  /\bi(?:'|\u2019)?ve (?:queued|scheduled|noted|added it to)\b/i,
  /\b(?:next|then) i(?:'|\u2019)?ll\b/i,
  /\bcoming (?:right )?up\b/i,
  /\bstand by\b/i,
  /\bshortly\b/i,
];

/**
 * Signals that the reply carries actual substance -- a real answer, a result,
 * a diff, a link, structured data. Any of these disqualifies the
 * acknowledgment-only verdict even if promise phrasing is also present
 * (e.g. "Here's the summary ... I'll also file a follow-up").
 */
const SUBSTANCE_PATTERNS: readonly RegExp[] = [
  /```/,
  /https?:\/\//i,
  /^\s*[-*]\s+\S/m,
  /^\s*\d+\.\s+\S/m,
  /\b(?:i|we) (?:already )?(?:ran|created|opened|posted|pushed|merged|updated|added|removed|fixed|filed|sent|deleted|renamed|replied|commented|assigned|resolved)\b/i,
  /\b(?:done|completed|finished|created|opened|posted|pushed|merged|updated)\b:/i,
];

/**
 * A reply long enough to be a real answer is not treated as a bare
 * acknowledgment. Promise-only replies are short by nature; this bound keeps
 * a substantive answer that happens to contain "I'll" from being misread.
 */
const ACKNOWLEDGMENT_MAX_LENGTH = 600;

/**
 * True when the whole reply is acknowledgment/promise and nothing else.
 *
 * Requires *every* non-empty clause to be promise-shaped, so a reply that
 * mixes real content with a promise is not misclassified. Exported for
 * direct unit coverage of the boundary.
 */
export function isAcknowledgmentOnlyReply(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > ACKNOWLEDGMENT_MAX_LENGTH) return false;
  if (SUBSTANCE_PATTERNS.some((pattern) => pattern.test(trimmed))) return false;

  const clauses = trimmed
    .split(/(?:[.!?\n]+)/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  if (clauses.length === 0) return false;

  return clauses.every((clause) => PROMISE_PATTERNS.some((pattern) => pattern.test(clause)));
}

/**
 * Accumulates liveness evidence across one accepted run's structured records.
 *
 * Intentionally monotonic: evidence is only ever added, never reset. In
 * particular `tool_gateway.session_created` neither adds progress nor clears
 * previously-recorded progress -- it is attachment telemetry on a side
 * channel.
 */
export class SlackRunEvidenceTracker {
  private durableAction = false;
  private gatewayAttached = false;
  private planOnly = false;

  /** Observes one parsed structured adapter record. */
  observeRecord(record: Record<string, unknown>): void {
    const type = typeof record.type === "string" ? record.type : null;
    const event = typeof record.event === "string" ? record.event : null;

    // Attachment telemetry. Recorded for diagnosis, never progress, and
    // explicitly does not touch `durableAction`.
    if (type === GATEWAY_ATTACHMENT_EVENT || event === GATEWAY_ATTACHMENT_EVENT) {
      this.gatewayAttached = true;
      return;
    }

    if (type && TERMINAL_RECORD_TYPES.has(type)) {
      if (readClassification(record) === PLAN_ONLY_CLASSIFICATION) this.planOnly = true;
    }

    if (type && TOOL_INVOCATION_RECORD_TYPES.has(type)) {
      this.durableAction = true;
      return;
    }

    if (type === "item.completed" && isRecord(record.item)) {
      const itemType = record.item.type;
      if (typeof itemType === "string" && TOOL_INVOCATION_ITEM_TYPES.has(itemType)) {
        this.durableAction = true;
      }
      return;
    }

    if (type === "assistant" && isRecord(record.message)) {
      if (messageContentHasToolUse(record.message.content)) this.durableAction = true;
    }
  }

  evidence(): SlackRunEvidence {
    return {
      durableAction: this.durableAction,
      gatewayAttached: this.gatewayAttached,
      planOnly: this.planOnly,
    };
  }

  /**
   * Final verdict for a run that reached a `done` terminal event.
   *
   * `plan_only` outranks everything: a terminal classification of `plan_only`
   * means runnable work was described without execution evidence, so it is
   * never terminal success even if some tool ran during planning.
   */
  classify(finalReplyText: string): SlackRunOutcome {
    if (this.planOnly) return "plan_only";
    if (this.durableAction) return "acted";
    return isAcknowledgmentOnlyReply(finalReplyText) ? "acknowledgment_only" : "acted";
  }
}
