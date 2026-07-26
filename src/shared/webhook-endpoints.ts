/**
 * Host webhook ingress routing, shared by the worker (which declares the
 * endpoint key) and the client Settings UI (which has to show operators the
 * URL Slack should POST to).
 *
 * This plugin never owns an HTTP path of its own. Providers declare a webhook
 * *endpoint key* through `ProviderWebhookDeclaration`
 * (src/core/provider-contract.ts), the generic composition in src/manifest.ts
 * publishes it, and the Paperclip host mounts it under a fixed company-scoped
 * route -- see "Required Paperclip host support for Slack" in README.md.
 *
 * Keeping that route template here, instead of asking operators to type it,
 * means the Settings UI offers exactly the URL the host actually serves.
 *
 * Must stay dependency-free (no node: imports): this module is pulled into the
 * client Settings bundle.
 */

/** Plugin id as published in the built manifest; part of the host webhook route. */
export const AGENT_IDENTITIES_PLUGIN_ID = "ambitresearch.paperclip-agent-identities";

/** Endpoint key the Slack provider declares for Events API delivery. */
export const SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY = "slack-events";

/** Host-owned path a declared webhook endpoint is mounted at for one company. */
export function pluginWebhookPath(companyId: string, endpointKey: string): string {
  return `/api/companies/${encodeURIComponent(companyId)}/plugins/${AGENT_IDENTITIES_PLUGIN_ID}/webhooks/${endpointKey}`;
}

/** Host-owned path Slack Events are delivered to for one company. */
export function slackEventsWebhookPath(companyId: string): string {
  return pluginWebhookPath(companyId, SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY);
}

/**
 * Derive the public Slack Events Request URL this deployment serves for
 * `companyId`, or null when no trustworthy URL can be derived.
 *
 * Returns null for a non-HTTPS origin on purpose: Slack only delivers events
 * over HTTPS, so a local dev host (`http://localhost:3100`) has no derivable
 * answer and the operator still has to paste a public tunnel URL by hand.
 */
export function buildSlackEventsRequestUrl(origin: string, companyId: string): string | null {
  const normalizedCompanyId = companyId.trim();
  if (!normalizedCompanyId) return null;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return `${parsed.origin}${slackEventsWebhookPath(normalizedCompanyId)}`;
}
