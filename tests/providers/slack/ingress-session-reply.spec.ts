import { describe, expect, it } from "vitest";
import {
  SlackSessionReplyAccumulator,
  truncateSlackReply,
} from "../../../src/providers/slack/ingress/session-reply.js";
import { SLACK_MESSAGE_TEXT_MAX_LENGTH } from "../../../src/shared/slack-bot-post-message-tool.js";

describe("SlackSessionReplyAccumulator", () => {
  it("streams and finishes ACPX agent message output", () => {
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
    ).toBe("Hey");
    expect(
      response.append(
        '{"type":"acpx.text_delta","text":" there","channel":"output","tag":"agent_message_chunk"}\n',
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
});
