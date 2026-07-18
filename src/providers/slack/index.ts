import type {
  IdentityProvider,
  IdentityProviderDefinition
} from "../../core/provider-contract.js";
import type {
  PluginContext,
  PluginWebhookInput,
  ToolRunContext,
} from "@paperclipai/plugin-sdk";
import type { ResourceReference } from "../../core/resource-reference.js";
import { createProviderTool } from "../../core/tool-pipeline.js";
import { redactSecrets } from "../../lib/redaction.js";
import { validateSlackConfig, projectSlackPluginConfig, type SlackAgentIdentity } from "./config.js";
import { resolveSlackCredential } from "./credentials.js";
import { contributeSlackAppManifestActions } from "./app-manifest.js";
import { slackWhoamiToolSpec } from "./tools/whoami.js";
import { slackManifestTools } from "./manifest-tools.js";
import {
  slackWebhookDeclarations,
  handleSlackProviderWebhook,
  type SlackAgentReply,
  type SlackAgentReplyStreamTarget,
} from "./ingress/provider-webhook.js";
import { SlackResponseStream } from "./ingress/response-stream.js";
import { slackBotPostMessageToolSpec } from "./tools/post-message.js";
import { slackBotPostMessageManifestTool } from "../../shared/slack-bot-post-message-tool.js";
import { slackAddReactionToolSpec, slackRemoveReactionToolSpec } from "./tools/react.js";

export const SLACK_PROVIDER_ID = "slack";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function postSlackAgentReply(ctx: PluginContext, reply: SlackAgentReply): Promise<void> {
  const registered = createProviderTool(slackProvider, slackBotPostMessageToolSpec, ctx, {
    resolveIdentity: async (_toolCtx, runCtx) => {
      if (runCtx.agentId !== reply.identity.agentId) {
        throw new Error("Slack reply identity does not match the routed agent.");
      }
      return reply.identity;
    },
    redactSecrets,
  });
  const runCtx: ToolRunContext = {
    agentId: reply.agentId,
    runId: reply.runId,
    companyId: reply.companyId,
    projectId: "",
  };
  const result = await registered.handler({
    channel: reply.channel,
    text: reply.text,
    ...(reply.threadTs ? { threadTs: reply.threadTs } : {}),
  }, runCtx);
  if (isRecord(result) && typeof result.error === "string") {
    throw new Error(result.error);
  }
}

function createSlackAgentReplyStream(
  ctx: PluginContext,
  target: SlackAgentReplyStreamTarget,
): SlackResponseStream {
  const runCtx: ToolRunContext = {
    agentId: target.agentId,
    runId: target.eventId,
    companyId: target.companyId,
    projectId: "",
  };
  return new SlackResponseStream({
    channel: target.channel,
    messageTs: target.messageTs,
    threadTs: target.threadTs,
    fetch: ctx.http.fetch,
    logger: ctx.logger,
    resolveToken: async () => {
      const credential = await resolveSlackCredential({
        identity: target.identity,
        ctx,
        runCtx,
      });
      return credential.token;
    },
    onDelivered: async (messageTs) => {
      await ctx.activity.log({
        companyId: target.companyId,
        entityType: "slack_message",
        entityId: messageTs,
        message: target.threadTs
          ? `Streamed a Slack reply in ${target.channel}`
          : `Posted a Slack reply in ${target.channel}`,
        metadata: {
          teamId: target.identity.identity.teamId,
          channel: target.channel,
          messageTs,
          ...(target.threadTs ? { threadTs: target.threadTs } : {}),
          agentId: target.agentId,
        },
      });
    },
  });
}

async function handleSlackWebhook(input: PluginWebhookInput, ctx: PluginContext) {
  return handleSlackProviderWebhook(
    input,
    ctx,
    (reply) => postSlackAgentReply(ctx, reply),
    (target) => createSlackAgentReplyStream(ctx, target),
  );
}

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
  handleWebhook: handleSlackWebhook
};
