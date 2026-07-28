import { slackBotWhoamiManifestTool } from "../../shared/slack-bot-whoami-tool.js";
import {
  slackBotAddReactionManifestTool,
  slackBotRemoveReactionManifestTool
} from "../../shared/slack-bot-reaction-tool-definition.js";
import { slackBotLookupChannelManifestTool } from "../../shared/slack-bot-lookup-channel-tool.js";

/**
 * The manifest-tool fragments the Slack provider contributes to the plugin
 * manifest. Mirrors `githubManifestTools` (../github/manifest-tools.ts).
 * `whoami` (DRO-972/#59), the two reaction tools (DRO-974/#61), and
 * `slack_bot_lookup_channel` (DRO-975/DRO-1160) all exist now. The
 * message/reply tool's manifest fragment
 * (`slackBotPostMessageManifestTool`, DRO-973) is appended separately in
 * index.ts.
 */
export const slackManifestTools = [
  slackBotWhoamiManifestTool,
  slackBotAddReactionManifestTool,
  slackBotRemoveReactionManifestTool,
  slackBotLookupChannelManifestTool
] as const;
