import { describe, expect, it, vi } from "vitest";
import { SlackResponseStream } from "../../../src/providers/slack/ingress/response-stream.js";

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("SlackResponseStream", () => {
  it("leaves a top-level response to the single final-message fallback", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      throw new Error(`Unexpected Slack URL: ${url}`);
    });
    const resolveToken = vi.fn(async () => "xoxb-test-token");
    const stream = new SlackResponseStream({
      channel: "D0123456789",
      fetch: fetchMock,
      resolveToken,
      logger: { warn: vi.fn() },
    });

    stream.start();
    stream.append("Draft text");
    await expect(stream.finish("Final answer")).resolves.toBe(false);
    await expect(stream.fail()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolveToken).not.toHaveBeenCalled();
  });

  it("sets native activity, streams answer chunks in order, stops, and clears status", async () => {
    const delivered = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/assistant.threads.setStatus")) return jsonResponse({ ok: true });
      if (url.endsWith("/chat.startStream")) {
        return jsonResponse({ ok: true, channel: "D0123456789", ts: "1719000001.123456" });
      }
      if (url.endsWith("/chat.appendStream")) {
        return jsonResponse({ ok: true, channel: "D0123456789", ts: "1719000001.123456" });
      }
      if (url.endsWith("/chat.stopStream")) {
        return jsonResponse({ ok: true, channel: "D0123456789", ts: "1719000001.123456" });
      }
      throw new Error(`Unexpected Slack URL: ${url}`);
    });
    const stream = new SlackResponseStream({
      channel: "D0123456789",
      threadTs: "1719000000.123456",
      fetch: fetchMock,
      resolveToken: async () => "xoxb-test-token",
      logger: { warn: vi.fn() },
      onDelivered: delivered,
    });

    stream.start();
    stream.append("Hello ");
    stream.append("world");
    await expect(stream.finish("Hello world")).resolves.toBe(true);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://slack.com/api/assistant.threads.setStatus",
      "https://slack.com/api/chat.startStream",
      "https://slack.com/api/chat.appendStream",
      "https://slack.com/api/chat.stopStream",
      "https://slack.com/api/assistant.threads.setStatus",
    ]);
    expect(requestBody(fetchMock.mock.calls[0])).toEqual({
      channel_id: "D0123456789",
      thread_ts: "1719000000.123456",
      status: "is working on your request...",
      loading_messages: [
        "is reading context...",
        "is running checks...",
        "is preparing a response...",
      ],
    });
    expect(requestBody(fetchMock.mock.calls[1])).toEqual({
      channel: "D0123456789",
      thread_ts: "1719000000.123456",
      markdown_text: "Hello ",
    });
    expect(requestBody(fetchMock.mock.calls[2])).toEqual({
      channel: "D0123456789",
      ts: "1719000001.123456",
      markdown_text: "world",
    });
    expect(requestBody(fetchMock.mock.calls[4])).toEqual({
      channel_id: "D0123456789",
      thread_ts: "1719000000.123456",
      status: "",
    });
    expect(delivered).toHaveBeenCalledWith("1719000001.123456");
  });

  it("returns control to the final-message fallback when Slack cannot start a stream", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/assistant.threads.setStatus")) return jsonResponse({ ok: true });
      if (url.endsWith("/chat.startStream")) return jsonResponse({ ok: false, error: "missing_scope" });
      throw new Error(`Unexpected Slack URL: ${url}`);
    });
    const stream = new SlackResponseStream({
      channel: "D0123456789",
      threadTs: "1719000000.123456",
      fetch: fetchMock,
      resolveToken: async () => "xoxb-test-token",
      logger: { warn: vi.fn() },
    });

    stream.start();
    stream.append("Hello");
    await expect(stream.finish("Hello")).resolves.toBe(false);
  });

  it("replaces a partial stream when the final answer is not a monotonic continuation", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/assistant.threads.setStatus")) return jsonResponse({ ok: true });
      if (url.endsWith("/chat.startStream")) {
        return jsonResponse({ ok: true, channel: "D0123456789", ts: "1719000001.123456" });
      }
      if (url.endsWith("/chat.stopStream")) {
        return jsonResponse({ ok: true, channel: "D0123456789", ts: "1719000001.123456" });
      }
      if (url.endsWith("/chat.update")) {
        return jsonResponse({ ok: true, channel: "D0123456789", ts: "1719000001.123456" });
      }
      throw new Error(`Unexpected Slack URL: ${url}`);
    });
    const stream = new SlackResponseStream({
      channel: "D0123456789",
      threadTs: "1719000000.123456",
      fetch: fetchMock,
      resolveToken: async () => "xoxb-test-token",
      logger: { warn: vi.fn() },
    });

    stream.start();
    stream.append("Draft text");
    await expect(stream.finish("Final answer")).resolves.toBe(true);

    const updateCall = fetchMock.mock.calls.find(([url]) => url.endsWith("/chat.update"));
    expect(updateCall).toBeDefined();
    expect(requestBody(updateCall as unknown[])).toEqual({
      channel: "D0123456789",
      ts: "1719000001.123456",
      text: "Final answer",
    });
  });
});
