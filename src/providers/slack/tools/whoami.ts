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
 * Credential-free identity self-check tool (DRO-1002 / #59).
 *
 * Deliberately mirrors `githubWhoamiToolSpec`: `requiresCredential: false`
 * means the shared pipeline (validate params -> resolve identity -> resolve
 * resource ref -> resolve credentials -> perform -> redact) skips credential
 * resolution entirely and calls `perform` with `token: null`. This tool never
 * calls Slack's `auth.test` and never touches the bot token/secrets sidecar
 * -- it only echoes the already-validated, publicly shareable identity
 * metadata configured for the calling agent (see `SlackAgentIdentity` in
 * `../config.js`).
 *
 * Note: openwiki/domain/slack-provider-design.md §6 originally scoped
 * `slack_bot_whoami` as a *credentialed* tool that verifies over the live
 * `auth.test` endpoint. The tracking issue (DRO-1002 / GitHub #59)
 * explicitly overrides that with `requiresCredential: false` and "prove
 * credential resolution is never invoked" as an acceptance criterion, i.e.
 * the same credential-free, configured-metadata-only contract as GitHub's
 * `github_bot_whoami`. This implementation follows the issue's explicit
 * acceptance criteria. A live-verifying variant, if still desired, would be
 * separate follow-up work and a different (credentialed) tool contract.
 */
export const slackWhoamiToolSpec: ProviderToolSpec<SlackAgentIdentity, ResourceReference> = {
  name: slackBotWhoamiToolName,
  metadata: slackBotWhoamiToolMetadata,
  requiresCredential: false,
  validateParams(_raw: unknown): ParamsValidation {
    return { ok: true, params: {} };
  },
  async perform(
    execution: ProviderToolExecution<SlackAgentIdentity, ResourceReference>
  ): Promise<unknown> {
    const identity = execution.identity.identity;
    return {
      content: `Configured Slack identity: ${identity.label} (team ${identity.teamId}, app ${identity.appId}, bot ${identity.botUserId}).`,
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
