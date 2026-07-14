import type {
  IdentityProvider,
  IdentityProviderDefinition
} from "../../core/provider-contract.js";
import type { ResourceReference } from "../../core/resource-reference.js";
import { validateSlackConfig, projectSlackPluginConfig, type SlackAgentIdentity } from "./config.js";
import { resolveSlackCredential } from "./credentials.js";
import { contributeSlackAppManifestActions } from "./app-manifest.js";
import { slackWhoamiToolSpec } from "./tools/whoami.js";
import { slackPostMessageToolSpec } from "./tools/post-message.js";
import { slackPostReplyToolSpec } from "./tools/post-reply.js";
import { slackManifestTools } from "./manifest-tools.js";

export const SLACK_PROVIDER_ID = "slack";

const slackProviderDefinition: IdentityProviderDefinition = {
  id: SLACK_PROVIDER_ID,
  name: "Slack",
  // Credential storage/resolution (DRO-969), the credential-free
  // `slack_bot_whoami` self-check (DRO-972), and the credentialed
  // `slack_bot_post_message`/`slack_bot_post_reply` tools (DRO-1003) all
  // exist now. Still "coming-soon" until the react/lookup-channel tools
  // (DRO-974/975) land — those round out the surface an operator actually
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
  // `whoami` is credential-free (DRO-972); `post_message`/`post_reply`
  // (DRO-1003) are credentialed but each opts into the live worker/manifest
  // surface individually via `live: true` (see `ProviderToolSpec.live` and
  // `ProviderRegistry.liveTools()`), same seam whoami already uses, so the
  // still-"coming-soon" provider status above doesn't gate them. The
  // remaining two Slack tools (react/lookup-channel) are implemented by
  // separate, dependency-blocked issues (DRO-974/975) and will be appended
  // here.
  tools: [slackWhoamiToolSpec, slackPostMessageToolSpec, slackPostReplyToolSpec],
  contributeActions: contributeSlackAppManifestActions,
  manifestTools: [...slackManifestTools]
};
