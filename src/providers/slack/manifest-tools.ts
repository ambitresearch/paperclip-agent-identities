import { slackBotWhoamiManifestTool } from "../../shared/slack-bot-whoami-tool.js";

/**
 * The manifest-tool fragments the Slack provider contributes to the plugin
 * manifest. Mirrors `githubManifestTools`. Only `whoami` exists so far
 * (DRO-972); the message/reply/react/lookup-channel tools land via their own
 * still-backlog issues (DRO-973/974/975) and will be appended here.
 */
export const slackManifestTools = [slackBotWhoamiManifestTool] as const;
