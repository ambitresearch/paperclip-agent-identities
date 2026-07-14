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
import { slackWebhookDeclarations, handleSlackProviderWebhook } from "./ingress/provider-webhook.js";

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
  // `whoami` is credential-free (DRO-972); the remaining four Slack tools
  // (message/reply/react/lookup-channel) are implemented by separate,
  // dependency-blocked issues (DRO-973/974/975) and will be appended here.
  tools: [slackWhoamiToolSpec],
  contributeActions: contributeSlackAppManifestActions,
  manifestTools: [...slackManifestTools],
  // HTTP Events API ingress (DRO-975): the design decision record
  // (openwiki/domain/slack-provisioning-decision.md) selects HTTP Events API
  // over Socket Mode as the default/only transport implemented here. Composed
  // through the generic `webhooks`/`handleWebhook` provider-contract seam --
  // no provider-specific branch in src/worker.ts or src/manifest.ts.
  webhooks: slackWebhookDeclarations,
  handleWebhook: handleSlackProviderWebhook
};
