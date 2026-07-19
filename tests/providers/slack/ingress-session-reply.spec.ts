import { describe, expect, it } from "vitest";
import {
  SlackSessionReplyAccumulator,
  truncateSlackReply,
} from "../../../src/providers/slack/ingress/session-reply.js";
import { SLACK_MESSAGE_TEXT_MAX_LENGTH } from "../../../src/shared/slack-bot-post-message-tool.js";

describe("SlackSessionReplyAccumulator", () => {
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
