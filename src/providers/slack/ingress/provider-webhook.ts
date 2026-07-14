import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { ProviderWebhookDeclaration } from "../../../core/provider-contract.js";
import { CONFIG_SCOPE } from "../../../config-source.js";
import { normalizeSettingsState } from "../../../core/identity-config.js";
import { resolveAgentIdentity } from "../../../core/agent-identity.js";
import { resolveSlackSigningSecret } from "../credentials.js";
import { projectSlackPluginConfig, type SlackAgentIdentity } from "../config.js";
import { handleSlackWebhook, type SlackWebhookHeaders } from "./webhook-handler.js";
import { shouldProcessSlackEvent } from "./dedup.js";

// Stable endpoint key this Slack ingress route registers under. Referenced
// by `slackWebhookDeclarations` (manifest composition) and
// `handleSlackProviderWebhook` (worker dispatch) so both stay in lockstep.
export const SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY = "slack-events";

// The manifest-facing declaration this provider contributes. Composed
// generically by `ProviderRegistry.webhooks()` -- see
// openwiki/domain/slack-provider-mvp.md §10: "added as a new worker route
// composed through the provider registry ... not a new worker.ts
// provider-specific branch."
export const slackWebhookDeclarations: readonly ProviderWebhookDeclaration[] = [
  {
    endpointKey: SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
    displayName: "Slack Events API",
    description:
      "Receives inbound Slack Events API deliveries (HTTP mode) and routes each event to exactly one agent by app ID + team ID, per openwiki/domain/slack-provider-design.md and slack-provider-mvp.md §10.",
  },
];

// `ctx.agents.invoke`/`.get` require a companyId alongside the agentId, but
// routing only resolves an agentId from the (appId, teamId) match. This
// plugin's identity config is a single flat map (no company-scoping key
// today -- see `AgentIdentitySettingsState`), so the companyId is looked up
// by scanning companies this plugin instance can see for the one whose agent
// roster contains the routed agentId. Fails closed (returns null, logged by
// the caller) rather than guessing/defaulting.
async function resolveCompanyIdForAgent(ctx: PluginContext, agentId: string): Promise<string | null> {
  const companies = await ctx.companies.list();
  for (const company of companies) {
    const agent = await ctx.agents.get(agentId, company.id).catch(() => null);
    if (agent) {
      return company.id;
    }
  }
  return null;
}

/**
 * Handles one inbound HTTP delivery routed to the `slack-events` endpoint
 * key. Delegates all signature/timestamp/routing/dedup logic to
 * `handleSlackWebhook` (pure, fully unit-tested) and only wires in the
 * `PluginContext`-backed dependencies (state, secrets, agent invocation).
 */
export async function handleSlackProviderWebhook(input: PluginWebhookInput, ctx: PluginContext): Promise<void> {
  const result = await handleSlackWebhook({
    rawBody: input.rawBody,
    headers: input.headers as SlackWebhookHeaders,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
    async getProjectedIdentities() {
      const state = normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE));
      return projectSlackPluginConfig(state.identities);
    },
    async resolveSigningSecret(agentId) {
      const identities = projectSlackPluginConfig(
        normalizeSettingsState(await ctx.state.get(CONFIG_SCOPE)).identities
      );
      const resolvedIdentity = resolveAgentIdentity<SlackAgentIdentity>(
        { identities },
        { agentId, companyId: "", projectId: "", runId: "" }
      );
      return resolveSlackSigningSecret(resolvedIdentity, (secretRef) => ctx.secrets.resolve(secretRef));
    },
    async shouldProcessEvent(agentId, eventId) {
      return shouldProcessSlackEvent(ctx.state, agentId, eventId);
    },
    async onAgentEvent(dispatch) {
      // Route to exactly one agent (already enforced by routeSlackEventToAgent
      // inside handleSlackWebhook) by invoking/waking it with the event
      // payload. No secret/token is included in this prompt payload -- only
      // the already-public team/app/event-type shape.
      const eventType =
        typeof dispatch.event === "object" && dispatch.event !== null && "type" in dispatch.event
          ? String((dispatch.event as { type?: unknown }).type)
          : "unknown";
      const companyId = await resolveCompanyIdForAgent(ctx, dispatch.agentId);
      if (!companyId) {
        ctx.logger.error("Slack webhook: could not resolve companyId for routed agent", {
          agentId: dispatch.agentId,
        });
        return;
      }
      await ctx.agents
        .invoke(dispatch.agentId, companyId, {
          prompt: `Slack event received (type: ${eventType}, team: ${dispatch.teamId}, app: ${dispatch.appId}).`,
          reason: "slack-inbound-event",
        })
        .catch((error) => {
          ctx.logger.error("Slack webhook: failed to invoke routed agent", {
            agentId: dispatch.agentId,
            reason: error instanceof Error ? error.message : String(error),
          });
        });
    },
    logger: ctx.logger,
  });

  ctx.logger.info("Slack webhook processed", { status: result.status });
}
