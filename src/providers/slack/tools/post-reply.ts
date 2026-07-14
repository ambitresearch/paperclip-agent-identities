import type {
  ProviderToolExecution,
  ProviderToolSpec
} from "../../../core/provider-contract.js";
import type { SlackAgentIdentity } from "../config.js";
import type { SlackChannelRef } from "../channel-ref.js";
import {
  slackBotPostReplyToolMetadata,
  slackBotPostReplyToolName
} from "../../../shared/slack-bot-post-reply-tool.js";
import {
  performSlackPostMessage,
  resolveSlackPostResourceRef,
  validateSlackPostParams
} from "./post-message-shared.js";

/**
 * Posts a threaded reply to an existing Slack message (DRO-1003 / upstream
 * issue #60). Same mandatory pipeline order as `slack_bot_post_message`;
 * differs only in requiring a resolved `threadTs` (mapped to `thread_ts` in
 * the `chat.postMessage` call).
 */
export const slackPostReplyToolSpec: ProviderToolSpec<SlackAgentIdentity, SlackChannelRef> = {
  name: slackBotPostReplyToolName,
  metadata: slackBotPostReplyToolMetadata,
  live: true,
  validateParams(raw: unknown) {
    return validateSlackPostParams(raw, { requireThreadTs: true });
  },
  async resolveResourceRef(input) {
    return resolveSlackPostResourceRef(input, { requireThreadTs: true });
  },
  async perform(
    execution: ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>
  ): Promise<unknown> {
    return performSlackPostMessage(execution, slackBotPostReplyToolName);
  }
};
