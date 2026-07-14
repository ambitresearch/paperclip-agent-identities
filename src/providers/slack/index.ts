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

export const SLACK_PROVIDER_ID = "slack";

const slackProviderDefinition: IdentityProviderDefinition = {
  id: SLACK_PROVIDER_ID,
  name: "Slack",
  // Credential storage/resolution lands here (DRO-969), and the identity
  // self-check tool (DRO-1002 / slack_bot_whoami) now exists. The remaining
  // four tools (post-message/reply-thread/react x2) are separate,
  // still-backlog work (DRO-973/974/975). Keep this "coming-soon" until the
  // message-sending tool surface lands too -- a whoami-only Slack identity
  // still can't do anything an operator would enable it for -- so settings
  // UI/registry `.enabled()` consumers don't surface a Slack identity option
  // with nothing actionable yet.
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
  // Only slack_bot_whoami (DRO-1002) exists so far. The remaining four tools
  // are implemented by separate, dependency-blocked issues (DRO-973/974/975).
  // This provider slice adds manifest-assisted setup actions (DRO-971) on top
  // of the credential storage/resolution slice (DRO-969) and the whoami tool.
  tools: [slackWhoamiToolSpec],
  contributeActions: contributeSlackAppManifestActions,
  manifestTools: slackManifestTools
};
