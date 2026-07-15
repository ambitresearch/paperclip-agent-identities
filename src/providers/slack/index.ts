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
import { slackBotPostMessageToolSpec } from "./tools/post-message.js";
import { slackBotPostMessageManifestTool } from "../../shared/slack-bot-post-message-tool.js";
import { slackAddReactionToolSpec, slackRemoveReactionToolSpec } from "./tools/react.js";

export const SLACK_PROVIDER_ID = "slack";

const slackProviderDefinition: IdentityProviderDefinition = {
  id: SLACK_PROVIDER_ID,
  name: "Slack",
  // Credential storage/resolution (DRO-969), the credential-free
  // `slack_bot_whoami` identity self-check tool (DRO-972),
  // slack_bot_post_message (posting + threaded replies, DRO-973), and the
  // two reaction tools (DRO-974: slack_bot_add_reaction/
  // slack_bot_remove_reaction) all exist now. The remaining tool
  // (lookup-channel, DRO-975) is separate, still-backlog work. The
  // manifest-assisted Slack setup UI (DRO-1025/#73) is also live in
  // Settings, and the provider picker there already surfaces Slack as
  // selectable (see SettingsPage.tsx). `status` stays "coming-soon" purely
  // because the *full* tool surface (lookup-channel) isn't finished yet --
  // not because setup is unavailable. `toolsStatus` is set to "enabled"
  // independently: it is what actually gates live tool registration
  // (registry.toolsEnabled()/liveTools(), consumed by worker.ts/
  // manifest.ts), so slack_bot_post_message, slack_bot_whoami, and the
  // reaction tools are reachable now even though `status` hasn't flipped.
  // Once lookup-channel lands, flip `status` to "enabled" too and
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
  // optional threadTs param; the two reaction tools (DRO-974) round out the
  // current tool surface. The remaining tool (lookup-channel) is a
  // separate, still-in-flight issue and will be appended here.
  // Heterogeneous TRefs across tools are fine here for the same reason
  // ../github/index.ts documents: ProviderToolSpec methods are bivariant.
  tools: [
    slackWhoamiToolSpec,
    slackBotPostMessageToolSpec,
    slackAddReactionToolSpec,
    slackRemoveReactionToolSpec
  ],
  contributeActions: contributeSlackAppManifestActions,
  manifestTools: [...slackManifestTools, slackBotPostMessageManifestTool],
  // HTTP Events API ingress (DRO-1005): the design decision record
  // (openwiki/domain/slack-provisioning-decision.md) selects HTTP Events API
  // over Socket Mode as the default/only transport implemented here. Composed
  // through the generic `webhooks`/`handleWebhook` provider-contract seam --
  // no provider-specific branch in src/worker.ts or src/manifest.ts.
  webhooks: slackWebhookDeclarations,
  handleWebhook: handleSlackProviderWebhook
};
