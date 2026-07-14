import { slackBotWhoamiManifestTool } from "../../shared/slack-bot-whoami-tool.js";
import { slackBotPostMessageManifestTool } from "../../shared/slack-bot-post-message-tool.js";

/**
 * The manifest-tool fragments the Slack provider contributes to the plugin
 * manifest. Mirrors `githubManifestTools`. `whoami` (DRO-972) and
 * `post_message` (DRO-973, covers posts and threaded replies) exist so far;
 * the react/lookup-channel tools land via their own still-backlog issues
 * (DRO-974/975) and will be appended here.
 */
export const slackManifestTools = [slackBotWhoamiManifestTool, slackBotPostMessageManifestTool] as const;
