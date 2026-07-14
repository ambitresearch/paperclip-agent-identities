import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceReference
} from "../../../core/provider-contract.js";
import type { SlackAgentIdentity } from "../config.js";
import {
  slackBotWhoamiToolMetadata,
  slackBotWhoamiToolName
} from "../../../shared/slack-bot-whoami-tool.js";

/**
 * Credential-free identity self-check tool (DRO-972 / upstream issue #59).
 * Mirrors `githubWhoamiToolSpec`: `requiresCredential: false` means the
 * pipeline never resolves a token before calling `perform`, and this handler
 * only ever reads the already-validated, public `SlackAgentIdentity` fields
 * (label, teamId, appId, botUserId, defaultChannel) — no bot token, signing
 * secret, or any other credential is touched. See
 * openwiki/domain/slack-provider-mvp.md for why the bot token/signing secret
 * never leave the credential sidecar.
 *
 * `live: true` composes this tool into the worker/manifest surface even
 * though the Slack PROVIDER is still `status: "coming-soon"` (the
 * message/reply/react tools that gate the provider to "enabled" haven't
 * landed yet). See `ProviderRegistry.liveTools()` -- the generic seam that
 * lets an individual tool opt in ahead of its provider, with no
 * provider-specific branch in `src/worker.ts`/`src/manifest.ts`.
 */
export const slackWhoamiToolSpec: ProviderToolSpec<SlackAgentIdentity, ResourceReference> = {
  name: slackBotWhoamiToolName,
  metadata: slackBotWhoamiToolMetadata,
  requiresCredential: false,
  live: true,
  // The Settings UI's "check Slack status" readout (DRO-976) invokes this
  // credential-free tool via `usePluginAction`, which only reaches
  // `ctx.actions.register` handlers -- see `uiActionInvocable`'s doc in
  // `core/provider-contract.ts` for why a credential-free tool needs this
  // opt-in to also be reachable from the UI.
  uiActionInvocable: true,
  validateParams(_raw: unknown): ParamsValidation {
    return { ok: true, params: {} };
  },
  async perform(
    execution: ProviderToolExecution<SlackAgentIdentity, ResourceReference>
  ): Promise<unknown> {
    const identity = execution.identity.identity;
    return {
      content: `Configured Slack identity: ${identity.label} (team ${identity.teamId}, app ${identity.appId}).`,
      data: {
        label: identity.label,
        teamId: identity.teamId,
        appId: identity.appId,
        botUserId: identity.botUserId,
        hasDefaultChannel: Boolean(identity.defaultChannel)
      }
    };
  }
};
