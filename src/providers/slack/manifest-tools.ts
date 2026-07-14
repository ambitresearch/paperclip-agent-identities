import { slackBotWhoamiManifestTool } from "../../shared/slack-bot-whoami-tool.js";
import { slackBotPostMessageManifestTool } from "../../shared/slack-bot-post-message-tool.js";
import { slackBotPostReplyManifestTool } from "../../shared/slack-bot-post-reply-tool.js";

/**
 * The manifest-tool fragments the Slack provider contributes to the plugin
 * manifest. Mirrors `githubManifestTools`. `whoami` (DRO-972) plus
 * `post_message`/`post_reply` (DRO-1003) exist so far; the react/lookup-channel
 * tools land via their own still-backlog issues (DRO-974/975) and will be
 * appended here.
 */
export const slackManifestTools = [
  slackBotWhoamiManifestTool,
  slackBotPostMessageManifestTool,
  slackBotPostReplyManifestTool
] as const;
