import type { PluginContext, PluginWebhookInput } from "@paperclipai/plugin-sdk";
import type { ProviderWebhookDeclaration } from "../../../core/provider-contract.js";
import { CONFIG_SCOPE } from "../../../config-source.js";
import { normalizeSettingsState } from "../../../core/identity-config.js";
import { resolveSlackSigningSecret } from "../credentials.js";
import { projectSlackPluginConfig, validateSlackConfig, type SlackAgentIdentity } from "../config.js";
import { handleSlackWebhook, type SlackWebhookHeaders } from "./webhook-handler.js";
import {
  completeSlackEventClaim,
  releaseSlackEventClaim,
  shouldProcessSlackEvent,
} from "./dedup.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the effective identity view once per delivery. A valid identity in
 * instance config is authoritative for that agent; missing or invalid
 * instance entries fall back to the settings-page projection. Both routing
 * and credential lookup consume this same immutable snapshot, preventing a
 * stale settings read from routing differently than signature resolution.
 */
async function buildSlackIdentitySnapshot(ctx: PluginContext): Promise<Record<string, SlackAgentIdentity>> {
  const [instanceConfig, settingsState] = await Promise.all([
    ctx.config.get(),
    ctx.state.get(CONFIG_SCOPE),
  ]);
  const snapshot = projectSlackPluginConfig(normalizeSettingsState(settingsState).identities);
  if (!isRecord(instanceConfig.identities)) return snapshot;

  for (const [agentId, rawIdentity] of Object.entries(instanceConfig.identities)) {
    const validated = validateSlackConfig(rawIdentity);
    if (typeof validated !== "string") snapshot[agentId] = validated;
  }
  return snapshot;
}

const MAX_SLACK_EVENT_TEXT_LENGTH = 4_096;
const MAX_SLACK_EVENT_FIELD_LENGTH = 256;

function boundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" ? value.slice(0, maxLength) : undefined;
}

function buildInvocationPrompt(dispatch: {
  readonly eventId: string;
  readonly teamId: string;
  readonly appId: string;
  readonly event: unknown;
}): string {
  const rawEvent = isRecord(dispatch.event) ? dispatch.event : {};
  const event = {
    type: boundedString(rawEvent.type, MAX_SLACK_EVENT_FIELD_LENGTH),
    text: boundedString(rawEvent.text, MAX_SLACK_EVENT_TEXT_LENGTH),
    channel: boundedString(rawEvent.channel, MAX_SLACK_EVENT_FIELD_LENGTH),
    user: boundedString(rawEvent.user, MAX_SLACK_EVENT_FIELD_LENGTH),
    ts: boundedString(rawEvent.ts, MAX_SLACK_EVENT_FIELD_LENGTH),
    thread_ts: boundedString(rawEvent.thread_ts, MAX_SLACK_EVENT_FIELD_LENGTH),
  };
  const payload = {
    eventId: boundedString(dispatch.eventId, MAX_SLACK_EVENT_FIELD_LENGTH),
    teamId: boundedString(dispatch.teamId, MAX_SLACK_EVENT_FIELD_LENGTH),
    appId: boundedString(dispatch.appId, MAX_SLACK_EVENT_FIELD_LENGTH),
    event,
  };
  return `Slack event received:\n${JSON.stringify(payload)}`;
}

/**
 * Handles one inbound HTTP delivery routed to the `slack-events` endpoint
 * key. Delegates all signature/timestamp/routing/dedup logic to
 * `handleSlackWebhook` (pure, fully unit-tested) and only wires in the
 * `PluginContext`-backed dependencies (state, secrets, agent invocation).
 */
export async function handleSlackProviderWebhook(input: PluginWebhookInput, ctx: PluginContext): Promise<void> {
  const identities = await buildSlackIdentitySnapshot(ctx);
  const result = await handleSlackWebhook({
    rawBody: input.rawBody,
    headers: input.headers as SlackWebhookHeaders,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
    nowMs: Date.now(),
    async getProjectedIdentities() {
      return identities;
    },
    async resolveSigningSecret(agentId) {
      const identity = identities[agentId];
      if (!identity) throw new Error(`No Slack identity configured for agent '${agentId}'.`);
      return resolveSlackSigningSecret({ agentId, identity }, (secretRef) => ctx.secrets.resolve(secretRef));
    },
    async shouldProcessEvent(agentId, eventId) {
      return shouldProcessSlackEvent(ctx.state, agentId, eventId);
    },
    async onAgentEvent(dispatch) {
      // Route to exactly one agent (already enforced by routeSlackEventToAgent
      // inside handleSlackWebhook) by invoking/waking it with the event
      // payload. No secret/token or arbitrary Slack field is included in the
      // prompt: only the bounded, explicitly whitelisted projection built
      // above is serialized.
      //
      // `shouldProcessEvent` above already recorded this (agentId, eventId)
      // pair as "seen" so a fast Slack retry landing before this dispatch
      // finishes doesn't double up. But that means a failure here -- unable
      // to resolve the routed agent's company, or the invoke call itself
      // failing -- must release that claim; otherwise the failure is
      // permanent (a genuine Slack retry of the same event_id would be
      // silently deduplicated forever and this work would never run).
      let companyId: string | null;
      try {
        companyId = await resolveCompanyIdForAgent(ctx, dispatch.agentId);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        ctx.logger.error("Slack webhook: failed to resolve companyId for routed agent", {
          agentId: dispatch.agentId,
          reason: failure.message,
        });
        await releaseSlackEventClaim(ctx.state, dispatch.agentId, dispatch.eventId, failure);
        throw failure;
      }
      if (!companyId) {
        const failure = new Error(`Slack webhook: unable to resolve companyId for agent ${dispatch.agentId}`);
        ctx.logger.error("Slack webhook: could not resolve companyId for routed agent", {
          agentId: dispatch.agentId,
        });
        await releaseSlackEventClaim(ctx.state, dispatch.agentId, dispatch.eventId, failure);
        // Re-throw (rather than swallow) so the caller -- and ultimately the
        // host's `handleWebhook` RPC caller -- observes this as a failed
        // delivery instead of a silent 200. See the module-level note below:
        // until the SDK/host webhook response contract exists (DRO-1074),
        // rejecting here is the only signal this plugin can give the host
        // that the delivery should not be acknowledged as a success.
        throw failure;
      }
      try {
        await ctx.agents.invoke(dispatch.agentId, companyId, {
          prompt: buildInvocationPrompt(dispatch),
          reason: "slack-inbound-event",
        });
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        ctx.logger.error("Slack webhook: failed to invoke routed agent", {
          agentId: dispatch.agentId,
          reason: failure.message,
        });
        await releaseSlackEventClaim(ctx.state, dispatch.agentId, dispatch.eventId, failure);
        // Propagate the failure so the host does not acknowledge work that
        // never reached the agent and Slack can retry the delivery.
        throw failure;
      }
      await completeSlackEventClaim(ctx.state, dispatch.agentId, dispatch.eventId);
    },
    logger: ctx.logger,
  });

  ctx.logger.info("Slack webhook processed", { status: result.status });

  // NOTE (tracked as DRO-1074, filed against the platform host/SDK, not this
  // plugin): `PluginWebhookInput`'s `onWebhook` RPC is typed `Promise<void>`
  // and the host's `/api/plugins/:pluginId/webhooks/:endpointKey` route
  // always responds `200 { deliveryId, status: "success" }` to the external
  // caller once this RPC resolves -- it does not forward `result.status`/
  // `result.body` computed above. That means Slack's `url_verification`
  // challenge, 401 (bad signature), and 429 (rate limited) responses
  // computed by `handleSlackWebhook` cannot reach Slack over HTTP today.
  //
  // Given that host limitation, do NOT throw for these non-transient ingress
  // rejections; throwing would only convert them into host-level 5xx failures
  // and trigger Slack retries for requests that should not be retried.
  // (Delivery-handoff failures inside `onAgentEvent` still throw so genuine
  // transient processing errors surface to the host.)
  if (result.status >= 400) {
    ctx.logger.warn("Slack webhook rejected; host cannot yet forward non-200 status/body", {
      status: result.status,
    });
  }
}
