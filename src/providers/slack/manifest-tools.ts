import { slackBotWhoamiManifestTool } from "../../shared/slack-bot-whoami-tool.js";
import {
  slackBotAddReactionManifestTool,
  slackBotRemoveReactionManifestTool
} from "../../shared/slack-bot-reaction-tool-definition.js";

/**
 * The manifest-tool fragments the Slack provider contributes to the plugin
 * manifest. Mirrors `githubManifestTools` (../github/manifest-tools.ts).
 * `whoami` (DRO-972/#59) and the two reaction tools (DRO-974/#61) exist so
 * far; the message/reply tool's manifest fragment
 * (`slackBotPostMessageManifestTool`, DRO-973) is appended separately in
 * index.ts. The lookup-channel tool (DRO-975) is still backlog work and will
 * be appended here as it lands.
 */
export const slackManifestTools = [
  slackBotWhoamiManifestTool,
  slackBotAddReactionManifestTool,
  slackBotRemoveReactionManifestTool
] as const;
