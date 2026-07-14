import type {
  IdentityProvider,
  IdentityProviderDefinition
} from "../../core/provider-contract.js";
import type { ResourceReference } from "../../core/resource-reference.js";
import { validateSlackConfig, projectSlackPluginConfig, type SlackAgentIdentity } from "./config.js";
import { resolveSlackCredential } from "./credentials.js";
import { contributeSlackAppManifestActions } from "./app-manifest.js";
import { slackBotPostMessageToolSpec } from "./tools/post-message.js";
import { slackBotPostMessageManifestTool } from "../../shared/slack-bot-post-message-tool.js";

export const SLACK_PROVIDER_ID = "slack";

const slackProviderDefinition: IdentityProviderDefinition = {
  id: SLACK_PROVIDER_ID,
  name: "Slack",
  // Credential storage/resolution lands here (DRO-969); slack_bot_post_message
  // (posting + threaded replies, DRO-973) is the first tool to land in the
  // Slack tool surface. The remaining tools (whoami/react/lookup-channel) are
  // separate, still-backlog work (DRO-974/975). `status` stays "coming-soon"
  // until the settings UI wiring for Slack identities is finished (tracked
  // separately in DRO-976/1006) — that keeps Slack out of the provider picker
  // and SUPPORTED_IDENTITY_PROVIDERS-driven UI surfaces. `toolsStatus` is set
  // to "enabled" independently: it is what actually gates live tool
  // registration (registry.toolsEnabled(), consumed by worker.ts/manifest.ts),
  // so slack_bot_post_message is reachable now even though the settings UI
  // isn't ready. Once the settings UI lands, flip `status` to "enabled" too
  // and `toolsStatus` becomes redundant (but harmless) to keep.
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
  // DRO-973 adds slack-post-message (covers both top-level posts and
  // threaded replies via the optional threadTs param). The remaining tools
  // (whoami/react/lookup-channel) are separate, still-in-flight issues.
  tools: [slackBotPostMessageToolSpec],
  contributeActions: contributeSlackAppManifestActions,
  manifestTools: [slackBotPostMessageManifestTool]
};
