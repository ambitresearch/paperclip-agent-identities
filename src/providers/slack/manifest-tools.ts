import { slackBotWhoamiManifestTool } from "../../shared/slack-bot-whoami-tool.js";

/**
 * The manifest-tool fragments the Slack provider contributes to the plugin
 * manifest. Mirrors `src/providers/github/manifest-tools.ts` -- `manifest.ts`
 * flat-maps this across enabled providers via `IdentityProvider.manifestTools`.
 * Only `slack_bot_whoami` (DRO-1002) exists so far; the remaining Slack tools
 * (post-message/reply/react) land via their own separate issues.
 */
export const slackManifestTools = [slackBotWhoamiManifestTool] as const;
