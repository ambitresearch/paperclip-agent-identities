import { describe, expect, it } from "vitest";
import {
  SlackSessionReplyAccumulator,
  truncateSlackReply,
} from "../../../src/providers/slack/ingress/session-reply.js";
import { SLACK_MESSAGE_TEXT_MAX_LENGTH } from "../../../src/shared/slack-bot-post-message-tool.js";

const TRANSPORT_WARNING =
  "Warning: Model metadata for gpt-5-codex not found. Defaulting to fallback metadata; " +
  "this can degrade performance and cause issues.";

describe("SlackSessionReplyAccumulator", () => {
  it("accepts only ACPX agent_message_chunk deltas with exact model provenance", () => {
    const response = new SlackSessionReplyAccumulator();

    expect(
      response.append(
        '{"type":"acpx.text_delta","text":"internal","channel":"analysis","tag":"agent_message_chunk"}\n',
      ),
    ).toBe("");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":"ignored","channel":"output","tag":"tool_message_chunk"}\n',
      ),
    ).toBe("");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":"Hey","channel":"output","tag":"agent_message_chunk"}\n',
      ),
    ).toBe("");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":"ignored","channel":"output","tag":"agent_message_chunk","messageId":"reply-1"}\n',
      ),
    ).toBe("");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":"ignored","channel":"output","tag":"agent_message_chunk","origin":"assistant"}\n',
      ),
    ).toBe("");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":"ignored","channel":"output","tag":"agent_message_chunk","origin":"assistant","kind":"diagnostic"}\n',
      ),
    ).toBe("");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":"Hey","channel":"output","tag":"agent_message_chunk","origin":"assistant","kind":"model"}\n',
      ),
    ).toBe("Hey");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":" there","channel":"output","tag":"agent_message_chunk","origin":"assistant","kind":"model"}\n',
      ),
    ).toBe(" there");
    expect(response.finish()).toBe("Hey there");
  });

  it("extracts structured final output and truncates oversized plain output", () => {
    const response = new SlackSessionReplyAccumulator();
    expect(response.append('{"type":"assistant","message":{"role":"assistant","content":"draft"}}\n')).toBe("");
    expect(response.append('{"type":"result","result":"final reply"}\n')).toBe("final reply");
    expect(response.finish()).toBe("final reply");

    const oversized = `${"x".repeat(SLACK_MESSAGE_TEXT_MAX_LENGTH)}extra`;
    expect(truncateSlackReply(oversized)).toHaveLength(SLACK_MESSAGE_TEXT_MAX_LENGTH);
    expect(truncateSlackReply(oversized)).toContain("[Response truncated]");
  });

  it("never streams a transport diagnostic that arrives before the real assistant delta", () => {
    const response = new SlackSessionReplyAccumulator();

    // Diagnostic arrives first, disguised as an agent_message_chunk (the
    // reported incident shape).
    expect(
      response.append(
        `${JSON.stringify({
          type: "acpx.text_delta",
          text: TRANSPORT_WARNING,
          channel: "output",
          tag: "agent_message_chunk",
        })}\n`,
      ),
    ).toBe("");

    // Real assistant answer follows with exact model provenance.
    expect(
      response.append(`${JSON.stringify({
        type: "acpx.text_delta",
        text: "The actual answer.",
        channel: "output",
        tag: "agent_message_chunk",
        origin: "assistant",
        kind: "model",
      })}\n`),
    ).toBe("The actual answer.");

    expect(response.finish()).toBe("The actual answer.");
  });

  it("returns no reply for a diagnostic-only structured run", () => {
    const response = new SlackSessionReplyAccumulator();
    expect(
      response.append(
        `${JSON.stringify({
          type: "acpx.text_delta",
          text: TRANSPORT_WARNING,
          channel: "output",
          tag: "agent_message_chunk",
        })}\n`,
      ),
    ).toBe("");
    expect(response.finish()).toBe("");
  });

  it("preserves plain-text fallback output and confirmed prose that quotes a diagnostic", () => {
    const fallback = new SlackSessionReplyAccumulator();
    expect(fallback.append("plain adapter output\n")).toBe("");
    expect(fallback.finish()).toBe("plain adapter output");

    const confirmed = new SlackSessionReplyAccumulator();
    const answer = `The adapter reported: ${TRANSPORT_WARNING}`;
    expect(
      confirmed.append(`${JSON.stringify({ type: "result", result: answer })}\n`),
    ).toBe(answer);
    expect(confirmed.finish()).toBe(answer);
  });

  it("handles split chunks and interleaving without leaking diagnostic text as a live stream", () => {
    const response = new SlackSessionReplyAccumulator();

    // A JSONL line split across multiple append() calls.
    const line = `${JSON.stringify({
      type: "acpx.text_delta",
      text: "part-one",
      channel: "output",
      tag: "agent_message_chunk",
    })}\n`;
    const mid = Math.floor(line.length / 2);
    expect(response.append(line.slice(0, mid))).toBe("");
    expect(response.append(line.slice(mid))).toBe("");

    // Interleaved thought/tool/analysis records must not leak either.
    expect(
      response.append('{"type":"acpx.text_delta","text":"thinking","channel":"thought","tag":"agent_thought_chunk"}\n'),
    ).toBe("");
    expect(
      response.append('{"type":"acpx.tool_call","name":"grep","text":"tool output"}\n'),
    ).toBe("");

    expect(
      response.append('{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}\n'),
    ).toBe("final answer");

    expect(response.finish()).toBe("final answer");
  });

  it("redacts/excludes lifecycle, stderr, and paperclip transport log lines from the reply", () => {
    const response = new SlackSessionReplyAccumulator();
    expect(response.append("[paperclip] Warning: could not read agent instructions file\n")).toBe("");
    expect(
      response.append('{"type":"acpx.status","text":"usage update","tag":"usage_update"}\n'),
    ).toBe("");
    expect(response.append('{"type":"acpx.error","message":"boom","code":"ACP_TURN_FAILED"}\n')).toBe("");
    expect(
      response.append('{"type":"result","result":"clean final reply"}\n'),
    ).toBe("clean final reply");
    expect(response.finish()).toBe("clean final reply");
  });
});
