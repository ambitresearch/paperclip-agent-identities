import type {
  IdentityProvider,
  IdentityProviderDefinition
} from "../../core/provider-contract.js";
import type { ResourceReference } from "../../core/resource-reference.js";
import { validateSlackConfig, projectSlackPluginConfig, type SlackAgentIdentity } from "./config.js";
import { resolveSlackCredential } from "./credentials.js";
import { contributeSlackAppManifestActions } from "./app-manifest.js";
import { slackWhoamiToolSpec } from "./tools/whoami.js";
import { slackManifestTools } from "./manifest-tools.js";
import { slackBotPostMessageToolSpec } from "./tools/post-message.js";
import { slackBotPostMessageManifestTool } from "../../shared/slack-bot-post-message-tool.js";

export const SLACK_PROVIDER_ID = "slack";

const slackProviderDefinition: IdentityProviderDefinition = {
  id: SLACK_PROVIDER_ID,
  name: "Slack",
  // Credential storage/resolution (DRO-969), the credential-free
  // `slack_bot_whoami` identity self-check tool (DRO-972), and
  // slack_bot_post_message (posting + threaded replies, DRO-973) all exist
  // now. The remaining tools (react/lookup-channel) are separate,
  // still-backlog work (DRO-974/975). The manifest-assisted Slack setup UI
  // (DRO-1025/#73) is also live in Settings, and the provider picker there
  // already surfaces Slack as selectable (see SettingsPage.tsx). `status`
  // stays "coming-soon" purely because the *full* tool surface (react/
  // lookup-channel) isn't finished yet -- not because setup is unavailable.
  // `toolsStatus` is set to "enabled" independently: it is what actually
  // gates live tool registration (registry.toolsEnabled()/liveTools(),
  // consumed by worker.ts/manifest.ts), so slack_bot_post_message and
  // slack_bot_whoami are reachable now even though `status` hasn't flipped.
  // Once react/lookup-channel land, flip `status` to "enabled" too and
  // `toolsStatus` becomes redundant (but harmless) to keep.
  status: "coming-soon",
  toolsStatus: "enabled",
  description:
    "Workspace identity for Slack messages and app-mediated actions."
};

export const slackProvider: IdentityProvider<SlackAgentIdentity, ResourceReference> = {
  id: SLACK_PROVIDER_ID,
  definition: slackProviderDefinition,
  validateConfig: validateSlackConfig,
  projectPluginConfig: projectSlackPluginConfig,
  resolveCredential: resolveSlackCredential,
  // `whoami` is credential-free (DRO-972); slack_bot_post_message
  // (DRO-973) covers both top-level posts and threaded replies via the
  // optional threadTs param. The remaining tools (react/lookup-channel) are
  // separate, still-in-flight issues and will be appended here.
  tools: [slackWhoamiToolSpec, slackBotPostMessageToolSpec],
  contributeActions: contributeSlackAppManifestActions,
  manifestTools: [...slackManifestTools, slackBotPostMessageManifestTool]
};
