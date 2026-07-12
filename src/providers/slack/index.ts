import type {
  IdentityProvider,
  IdentityProviderDefinition
} from "../../core/provider-contract.js";
import type { ResourceReference } from "../../core/resource-reference.js";
import { validateSlackConfig, projectSlackPluginConfig, type SlackAgentIdentity } from "./config.js";
import { resolveSlackCredential } from "./credentials.js";

export const SLACK_PROVIDER_ID = "slack";

const slackProviderDefinition: IdentityProviderDefinition = {
  id: SLACK_PROVIDER_ID,
  name: "Slack",
  // Credential storage/resolution lands here (DRO-969); the Slack tool
  // surface (whoami/post-message/reply-thread/react/lookup-channel) is
  // separate, still-backlog work (DRO-971/973/974/975). Keep this
  // "coming-soon" until at least one tool exists to consume the credential,
  // so settings UI/registry `.enabled()` consumers don't surface a Slack
  // identity option with nothing it can do yet.
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
  // No tools yet — the five Slack tools are implemented by separate,
  // dependency-blocked issues. This provider slice is scoped to credential
  // storage/resolution only (DRO-969).
  tools: [],
  manifestTools: []
};
