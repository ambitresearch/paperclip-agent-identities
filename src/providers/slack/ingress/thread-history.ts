import type { PluginContext } from "@paperclipai/plugin-sdk";

export const SLACK_THREAD_HISTORY_MESSAGE_LIMIT = 20;
export const SLACK_THREAD_HISTORY_PAGE_LIMIT = 3;
export const SLACK_THREAD_HISTORY_PAGE_SIZE = 100;
export const SLACK_THREAD_HISTORY_TEXT_MAX_LENGTH = 2_048;
export const SLACK_THREAD_HISTORY_MAX_BYTES = 8_192;
export const SLACK_THREAD_HISTORY_TIMEOUT_MS = 2_000;

const SLACK_MESSAGE_TS_PATTERN = /^[0-9]{10,}\.[0-9]{6}$/;

export interface SlackThreadHistoryMessage {
  readonly ts: string;
  readonly threadTs: string;
  readonly author: {
    readonly kind: "user" | "bot" | "unknown";
    readonly id?: string;
  };
  readonly text?: string;
  readonly deleted?: true;
}

export interface SlackThreadHistory {
  readonly channel: string;
  readonly threadTs: string;
  readonly messages: readonly SlackThreadHistoryMessage[];
  readonly truncated: boolean;
}

interface SlackRepliesResponse {
  readonly ok?: unknown;
  readonly error?: unknown;
  readonly messages?: unknown;
  readonly response_metadata?: { readonly next_cursor?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : undefined;
}

function compareSlackTs(left: string, right: string): number {
  const [leftSeconds, leftMicros] = left.split(".");
  const [rightSeconds, rightMicros] = right.split(".");
  if (leftSeconds.length !== rightSeconds.length) return leftSeconds.length - rightSeconds.length;
  const seconds = leftSeconds.localeCompare(rightSeconds);
  return seconds || leftMicros.localeCompare(rightMicros);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(`${result}${character}`, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

function projectMessage(
  value: unknown,
  channel: string,
  rootTs: string,
  currentTs: string,
): SlackThreadHistoryMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.channel === "string" && value.channel !== channel) {
    throw new Error("Slack thread history returned a message from another channel.");
  }
  const ts = boundedId(value.ts);
  if (!ts || !SLACK_MESSAGE_TS_PATTERN.test(ts) || compareSlackTs(ts, currentTs) >= 0) return null;
  const messageThreadTs = boundedId(value.thread_ts);
  if (ts !== rootTs && messageThreadTs !== rootTs) {
    throw new Error("Slack thread history returned a message from another thread.");
  }
  if (ts === rootTs && messageThreadTs && messageThreadTs !== rootTs) {
    throw new Error("Slack thread history returned an invalid root message.");
  }

  const subtype = boundedId(value.subtype);
  if (subtype === "message_deleted" || value.hidden === true) {
    return {
      ts,
      threadTs: rootTs,
      author: { kind: "unknown" },
      deleted: true,
    };
  }

  const userId = boundedId(value.user);
  const botId = boundedId(value.bot_id);
  const rawText = typeof value.text === "string" ? value.text : "";
  const text = truncateUtf8(
    rawText.slice(0, SLACK_THREAD_HISTORY_TEXT_MAX_LENGTH),
    SLACK_THREAD_HISTORY_TEXT_MAX_LENGTH,
  );
  if (!text && !userId && !botId) return null;
  return {
    ts,
    threadTs: rootTs,
    author: userId
      ? { kind: "user", id: userId }
      : botId
        ? { kind: "bot", id: botId }
        : { kind: "unknown" },
    ...(text ? { text } : {}),
  };
}

function applyHistoryBounds(
  channel: string,
  threadTs: string,
  messages: SlackThreadHistoryMessage[],
  sourceTruncated: boolean,
): SlackThreadHistory {
  const unique = [...new Map(messages.map((message) => [message.ts, message])).values()]
    .sort((left, right) => compareSlackTs(left.ts, right.ts));
  const selected: SlackThreadHistoryMessage[] = [];
  let bytes = 0;
  let truncated = sourceTruncated || unique.length > SLACK_THREAD_HISTORY_MESSAGE_LIMIT;
  for (const message of unique.slice(-SLACK_THREAD_HISTORY_MESSAGE_LIMIT).reverse()) {
    const messageBytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (messageBytes > SLACK_THREAD_HISTORY_MAX_BYTES || bytes + messageBytes > SLACK_THREAD_HISTORY_MAX_BYTES) {
      truncated = true;
      continue;
    }
    selected.push(message);
    bytes += messageBytes;
  }
  selected.reverse();
  return { channel, threadTs, messages: selected, truncated };
}

export async function fetchSlackThreadHistory(input: {
  readonly ctx: Pick<PluginContext, "http">;
  readonly token: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly currentTs: string;
  readonly timeoutMs?: number;
}): Promise<SlackThreadHistory> {
  if (!input.channel.trim() || input.channel !== input.channel.trim() || input.channel.length > 256) {
    throw new Error("Slack thread history channel is invalid.");
  }
  if (!SLACK_MESSAGE_TS_PATTERN.test(input.threadTs) || !SLACK_MESSAGE_TS_PATTERN.test(input.currentTs)) {
    throw new Error("Slack thread history timestamp is invalid.");
  }
  if (compareSlackTs(input.threadTs, input.currentTs) >= 0) {
    throw new Error("Slack thread history requires a reply after its root message.");
  }
  const timeoutMs = input.timeoutMs ?? SLACK_THREAD_HISTORY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > SLACK_THREAD_HISTORY_TIMEOUT_MS) {
    throw new Error("Slack thread history timeout is invalid.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const projected: SlackThreadHistoryMessage[] = [];
  let cursor: string | undefined;
  let sourceTruncated = false;
  try {
    for (let page = 0; page < SLACK_THREAD_HISTORY_PAGE_LIMIT; page += 1) {
      const params = new URLSearchParams({
        channel: input.channel,
        ts: input.threadTs,
        latest: input.currentTs,
        inclusive: "false",
        limit: String(SLACK_THREAD_HISTORY_PAGE_SIZE),
      });
      if (cursor) params.set("cursor", cursor);
      const response = await input.ctx.http.fetch("https://slack.com/api/conversations.replies", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.token}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as SlackRepliesResponse;
      if (!response.ok || body.ok !== true || !Array.isArray(body.messages)) {
        const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new Error(`Slack thread history lookup failed: ${reason}`);
      }
      for (const message of body.messages) {
        const safeMessage = projectMessage(message, input.channel, input.threadTs, input.currentTs);
        if (safeMessage) projected.push(safeMessage);
      }
      const nextCursor = boundedId(body.response_metadata?.next_cursor);
      if (!nextCursor) break;
      cursor = nextCursor;
      if (page === SLACK_THREAD_HISTORY_PAGE_LIMIT - 1) sourceTruncated = true;
    }
  } finally {
    clearTimeout(timeout);
  }
  return applyHistoryBounds(input.channel, input.threadTs, projected, sourceTruncated);
}
