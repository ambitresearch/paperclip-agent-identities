const SLACK_STREAM_CHUNK_MAX_LENGTH = 12_000;

const DEFAULT_STATUS = "is working on your request...";
const DEFAULT_LOADING_MESSAGES = [
  "is reading context...",
  "is running checks...",
  "is preparing a response...",
] as const;
const WORKING_REACTION = "hourglass_flowing_sand";

type SlackFetch = (input: string, init?: RequestInit) => Promise<Response>;

interface SlackStreamLogger {
  warn(message: string, metadata?: Record<string, unknown>): void;
}

export interface SlackResponseStreamOptions {
  readonly channel: string;
  readonly messageTs?: string;
  readonly threadTs?: string;
  readonly fetch: SlackFetch;
  readonly resolveToken: () => Promise<string>;
  readonly logger: SlackStreamLogger;
  readonly onDelivered?: (messageTs: string) => Promise<void>;
}

interface SlackApiResult {
  readonly ok: boolean;
  readonly body: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeSlackErrorCode(value: unknown): string {
  return typeof value === "string" && /^[a-z0-9_]+$/i.test(value) ? value : "unknown_error";
}

function safePrefix(value: string, maxLength: number): string {
  let prefix = value.slice(0, maxLength);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return prefix;
}

function splitStreamText(value: string): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > 0) {
    const chunk = safePrefix(remaining, SLACK_STREAM_CHUNK_MAX_LENGTH);
    if (!chunk) break;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

/**
 * Serializes Slack's status and final-message APIs for one inbound agent reply.
 * The caller supplies only the completed user-facing text. This class never sees
 * raw model events, reasoning records, tool arguments, or tool results.
 */
export class SlackResponseStream {
  private queue: Promise<void> = Promise.resolve();
  private tokenPromise: Promise<string | null> | undefined;
  private streamTs: string | undefined;
  private streamedText = "";
  private streamUnavailable = false;
  private streamBroken = false;
  private deliveredNotified = false;
  private workingReactionAdded = false;

  constructor(private readonly options: SlackResponseStreamOptions) {}

  start(): void {
    void this.serialize(async () => {
      const status = this.options.threadTs
        ? await this.setStatus(DEFAULT_STATUS, DEFAULT_LOADING_MESSAGES)
        : undefined;
      if (!status?.ok) await this.addWorkingReaction();
    }).catch(() => undefined);
  }

  finish(finalText: string): Promise<boolean> {
    return this.serialize(async () => {
      const streamed = await this.finishInternal(finalText);
      await this.removeWorkingReaction();
      return streamed;
    }).catch(() => false);
  }

  fail(): Promise<void> {
    return this.serialize(async () => {
      if (this.options.threadTs) {
        if (this.streamTs) await this.stopStream();
        await this.clearStatus();
      }
      await this.removeWorkingReaction();
    }).catch(() => undefined);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async getToken(): Promise<string | null> {
    this.tokenPromise ??= this.options.resolveToken()
      .then((token) => token.trim() || null)
      .catch(() => {
        this.options.logger.warn("Slack response streaming could not resolve the bot credential.");
        return null;
      });
    return this.tokenPromise;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<SlackApiResult> {
    const token = await this.getToken();
    if (!token) return { ok: false, body: {} };

    let response: Response;
    try {
      response = await this.options.fetch(`https://slack.com/api/${method}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(body),
      });
    } catch {
      this.options.logger.warn("Slack response streaming request failed before receiving a response.", { method });
      return { ok: false, body: {} };
    }

    const parsed = await response.json().catch(() => ({})) as unknown;
    const responseBody = isRecord(parsed) ? parsed : {};
    if (!response.ok || responseBody.ok !== true) {
      this.options.logger.warn("Slack response streaming API call was rejected.", {
        method,
        code: response.status === 429 ? "rate_limited" : safeSlackErrorCode(responseBody.error),
      });
      return { ok: false, body: responseBody };
    }

    return { ok: true, body: responseBody };
  }

  private setStatus(status: string, loadingMessages?: readonly string[]): Promise<SlackApiResult> {
    return this.call("assistant.threads.setStatus", {
      channel_id: this.options.channel,
      thread_ts: this.options.threadTs,
      status,
      ...(loadingMessages ? { loading_messages: [...loadingMessages] } : {}),
    });
  }

  private async clearStatus(): Promise<void> {
    await this.setStatus("");
  }

  private async addWorkingReaction(): Promise<void> {
    if (!this.options.messageTs) return;
    const result = await this.call("reactions.add", {
      channel: this.options.channel,
      timestamp: this.options.messageTs,
      name: WORKING_REACTION,
    });
    this.workingReactionAdded = result.ok;
  }

  private async removeWorkingReaction(): Promise<void> {
    if (!this.workingReactionAdded || !this.options.messageTs) return;
    await this.call("reactions.remove", {
      channel: this.options.channel,
      timestamp: this.options.messageTs,
      name: WORKING_REACTION,
    });
    this.workingReactionAdded = false;
  }

  private async appendInternal(text: string): Promise<void> {
    if (!this.options.threadTs) return;
    if (this.streamUnavailable || this.streamBroken) return;

    for (const chunk of splitStreamText(text)) {
      if (!this.streamTs) {
        const started = await this.call("chat.startStream", {
          channel: this.options.channel,
          thread_ts: this.options.threadTs,
          markdown_text: chunk,
        });
        const messageTs = typeof started.body.ts === "string" ? started.body.ts : "";
        if (!started.ok || !messageTs) {
          this.streamUnavailable = true;
          return;
        }
        this.streamTs = messageTs;
      } else {
        const appended = await this.call("chat.appendStream", {
          channel: this.options.channel,
          ts: this.streamTs,
          markdown_text: chunk,
        });
        if (!appended.ok) {
          this.streamBroken = true;
          return;
        }
      }
      this.streamedText += chunk;
    }
  }

  private async stopStream(): Promise<void> {
    if (!this.streamTs) return;
    await this.call("chat.stopStream", {
      channel: this.options.channel,
      ts: this.streamTs,
    });
  }

  private async repairStream(finalText: string): Promise<boolean> {
    if (!this.streamTs) return false;
    await this.stopStream();
    const updated = await this.call("chat.update", {
      channel: this.options.channel,
      ts: this.streamTs,
      text: finalText,
    });
    if (!updated.ok) return false;
    await this.notifyDelivered();
    return true;
  }

  private async finishInternal(finalText: string): Promise<boolean> {
    if (!this.options.threadTs) return false;

    if (!finalText) {
      if (this.streamTs) await this.stopStream();
      await this.clearStatus();
      return false;
    }

    if (this.streamTs && (this.streamBroken || !finalText.startsWith(this.streamedText))) {
      const repaired = await this.repairStream(finalText);
      await this.clearStatus();
      return repaired;
    }

    if (!this.streamTs && !this.streamUnavailable) {
      await this.appendInternal(finalText);
    } else if (this.streamTs) {
      await this.appendInternal(finalText.slice(this.streamedText.length));
    }

    if (this.streamTs && this.streamBroken) {
      const repaired = await this.repairStream(finalText);
      await this.clearStatus();
      return repaired;
    }

    if (!this.streamTs) {
      await this.clearStatus();
      return false;
    }

    await this.stopStream();
    await this.clearStatus();
    await this.notifyDelivered();
    return true;
  }

  private async notifyDelivered(): Promise<void> {
    if (this.deliveredNotified || !this.streamTs || !this.options.onDelivered) return;
    this.deliveredNotified = true;
    try {
      await this.options.onDelivered(this.streamTs);
    } catch {
      this.options.logger.warn("Slack streamed reply was delivered but activity logging failed.");
    }
  }
}
