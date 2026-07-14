import type {
  ProviderToolExecution,
  ProviderToolSpec
} from "../../../core/provider-contract.js";
import type { SlackAgentIdentity } from "../config.js";
import type { SlackChannelRef } from "../channel-ref.js";
import {
  slackBotPostMessageToolMetadata,
  slackBotPostMessageToolName
} from "../../../shared/slack-bot-post-message-tool.js";
import {
  performSlackPostMessage,
  resolveSlackPostResourceRef,
  validateSlackPostParams
} from "./post-message-shared.js";

/**
 * Posts a message to a Slack conversation (DRO-1003 / upstream issue #60).
 * Mandatory pipeline order: validate params -> resolve identity -> resolve
 * resource ref (channel-ref.ts) -> resolve credentials (bot token) ->
 * perform (`chat.postMessage`) -> redact. `requiresCredential` defaults to
 * `true` (omitted here), unlike the credential-free `slack_bot_whoami`.
 */
export const slackPostMessageToolSpec: ProviderToolSpec<SlackAgentIdentity, SlackChannelRef> = {
  name: slackBotPostMessageToolName,
  metadata: slackBotPostMessageToolMetadata,
  live: true,
  validateParams(raw: unknown) {
    return validateSlackPostParams(raw, { requireThreadTs: false });
  },
  async resolveResourceRef(input) {
    return resolveSlackPostResourceRef(input, { requireThreadTs: false });
  },
  async perform(
    execution: ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>
  ): Promise<unknown> {
    return performSlackPostMessage(execution, slackBotPostMessageToolName);
  }
};
