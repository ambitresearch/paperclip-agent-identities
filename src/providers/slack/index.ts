import type {
  IdentityProvider,
  IdentityProviderDefinition
} from "../../core/provider-contract.js";
import type { ResourceReference } from "../../core/resource-reference.js";
import { validateSlackConfig, projectSlackPluginConfig, type SlackAgentIdentity } from "./config.js";
import { resolveSlackCredential } from "./credentials.js";
import { contributeSlackAppManifestActions } from "./app-manifest.js";
import { slackWhoamiToolSpec } from "./tools/whoami.js";
import { slackBotPostMessageToolSpec } from "./tools/post-message.js";
import { slackManifestTools } from "./manifest-tools.js";

export const SLACK_PROVIDER_ID = "slack";

const slackProviderDefinition: IdentityProviderDefinition = {
  id: SLACK_PROVIDER_ID,
  name: "Slack",
  // Credential storage/resolution (DRO-969) and the credential-free
  // `slack_bot_whoami` identity self-check tool (DRO-972) both exist now.
  // Still "coming-soon" until the message/reply/react/lookup-channel tools
  // (DRO-973/974/975) land — those are the actions an operator actually
  // wants a Slack identity for, so settings UI/registry `.enabled()`
  // consumers shouldn't surface Slack as ready until that surface exists.
  status: "coming-soon",
  description:
    "Workspace identity for Slack messages and app-mediated actions."
};

export const slackProvider: IdentityProvider<SlackAgentIdentity, ResourceReference> = {
  id: SLACK_PROVIDER_ID,
  definition: slackProviderDefinition,
  validateConfig: validateSlackConfig,
  projectPluginConfig: projectSlackPluginConfig,
  resolveCredential: resolveSlackCredential,
  // `whoami` is credential-free (DRO-972); `slack_bot_post_message` (DRO-973,
  // covers both top-level posts and threaded replies via the optional
  // `threadTs` param) is credentialed and opts into the live surface via its
  // own `live: true`. The remaining two tools (react/lookup-channel) are
  // implemented by separate, dependency-blocked issues (DRO-974/975) and
  // will be appended here.
  tools: [slackWhoamiToolSpec, slackBotPostMessageToolSpec],
  contributeActions: contributeSlackAppManifestActions,
  manifestTools: [...slackManifestTools]
};
