import { SLACK_MESSAGE_TEXT_MAX_LENGTH } from "../../../shared/slack-bot-post-message-tool.js";

const TRUNCATION_NOTICE = "\n\n[Response truncated]";
const MAX_JSONL_LINE_LENGTH = 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTextContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;

  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (!isRecord(part) || typeof part.text !== "string") continue;
    if (part.type === undefined || part.type === "text" || part.type === "output_text") {
      parts.push(part.text);
    }
  }
  return parts.length > 0 ? parts.join("") : null;
}

function safePrefix(value: string, maxLength: number): string {
  let prefix = value.slice(0, maxLength);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

export function truncateSlackReply(value: string): string {
  if (value.length <= SLACK_MESSAGE_TEXT_MAX_LENGTH) return value;
  const prefixLength = SLACK_MESSAGE_TEXT_MAX_LENGTH - TRUNCATION_NOTICE.length;
  return `${safePrefix(value, prefixLength)}${TRUNCATION_NOTICE}`;
}

interface StructuredReply {
  readonly text: string;
  readonly priority: number;
  readonly source: "result" | "codex" | "assistant" | "claude-delta" | "gemini-delta";
}

/**
 * Reduces an agent CLI's stdout stream to the final user-facing reply.
 *
 * Paperclip session chunks contain the adapter's raw stdout. Structured CLIs
 * emit JSONL lifecycle, hook, tool, and result records on that same stream, so
 * concatenating chunks would send the entire transcript to Slack. This
 * accumulator parses complete JSONL records incrementally, prefers explicit
 * final-result records, and retains bounded plain stdout only as a fallback
 * for adapters that do not emit structured output.
 */
export class SlackSessionReplyAccumulator {
  private pending = "";
  private discardingOversizedLine = false;
  private fallback = "";
  private structured: StructuredReply | null = null;
  private streamableText = "";
  private emittedStreamableLength = 0;

  /**
   * Appends raw adapter stdout and returns only newly available, safe,
   * user-facing answer text. Lifecycle records, tool records, diagnostics,
   * stderr, and model reasoning never become streamable output.
   */
  append(message: string): string {
    if (this.discardingOversizedLine) {
      const newlineIndex = message.indexOf("\n");
      if (newlineIndex < 0) return "";
      this.discardingOversizedLine = false;
      message = message.slice(newlineIndex + 1);
    }

    this.pending += message;

    let newlineIndex = this.pending.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      this.consumeLine(line, true);
      newlineIndex = this.pending.indexOf("\n");
    }

    if (this.pending.length > MAX_JSONL_LINE_LENGTH) {
      this.pending = "";
      this.discardingOversizedLine = true;
    }

    const delta = this.streamableText.slice(this.emittedStreamableLength);
    this.emittedStreamableLength = this.streamableText.length;
    return delta;
  }

  finish(): string {
    if (this.pending && !this.discardingOversizedLine) {
      this.consumeLine(this.pending, false);
    }
    this.pending = "";
    this.discardingOversizedLine = false;
    return truncateSlackReply((this.structured?.text ?? this.fallback).trim());
  }

  private consumeLine(line: string, hadNewline: boolean): void {
    const trimmed = line.trim();
    if (!trimmed) {
      if (hadNewline) this.appendFallback("\n");
      return;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        this.consumeStructuredRecord(parsed);
        // Adapter JSONL records always carry a string `type`. A JSON object
        // without that marker may itself be the intended plain-text reply.
        if (typeof parsed.type === "string") return;
      }
    } catch {
      // Non-JSON stdout is the compatibility fallback for plain-text CLIs.
    }

    // Paperclip runner diagnostics are transport metadata, not agent replies.
    if (trimmed.startsWith("[paperclip]")) return;
    this.appendFallback(hadNewline ? `${line}\n` : line);
  }

  private consumeStructuredRecord(record: Record<string, unknown>): void {
    if (record.type === "result" && typeof record.result === "string") {
      this.setStructured(record.result, 3, "result", true);
      return;
    }

    if (record.type === "item.completed" && isRecord(record.item) && record.item.type === "agent_message") {
      const text = readTextContent(record.item.text ?? record.item.content);
      if (text) this.setStructured(text, 3, "codex", true);
      return;
    }

    if (
      record.type === "stream_event" &&
      isRecord(record.event) &&
      record.event.type === "content_block_delta" &&
      isRecord(record.event.delta) &&
      record.event.delta.type === "text_delta" &&
      typeof record.event.delta.text === "string"
    ) {
      const previous = this.structured?.source === "claude-delta" ? this.structured.text : "";
      this.setStructured(`${previous}${record.event.delta.text}`, 2, "claude-delta", true);
      return;
    }

    if (record.type === "assistant" && isRecord(record.message) && record.message.role === "assistant") {
      const text = readTextContent(record.message.content);
      if (text) this.setStructured(text, 2, "assistant");
      return;
    }

    if (record.type === "message" && record.role === "assistant") {
      const text = readTextContent(record.content);
      if (!text) return;
      if (record.delta === true && this.structured?.source === "gemini-delta") {
        this.setStructured(`${this.structured.text}${text}`, 2, "gemini-delta", true);
      } else {
        this.setStructured(
          text,
          2,
          record.delta === true ? "gemini-delta" : "assistant",
          record.delta === true,
        );
      }
    }
  }

  private setStructured(
    text: string,
    priority: number,
    source: StructuredReply["source"],
    streamable = false,
  ): void {
    if (!text.trim()) return;
    if (this.structured && priority < this.structured.priority) return;
    this.structured = { text, priority, source };
    if (streamable) this.extendStreamableText(text);
  }

  private extendStreamableText(text: string): void {
    if (text.startsWith(this.streamableText)) {
      this.streamableText = text;
    }
  }

  private appendFallback(value: string): void {
    const retainedLimit = SLACK_MESSAGE_TEXT_MAX_LENGTH + 1;
    if (this.fallback.length >= retainedLimit) return;
    this.fallback += value.slice(0, retainedLimit - this.fallback.length);
  }
}
