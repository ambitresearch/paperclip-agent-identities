import { verifySlackSignature } from "./signature.js";
import { routeSlackEventToAgent } from "./routing.js";
import { isWithinSlackRateLimit } from "./rate-limit.js";
import type { SlackAgentIdentity } from "../config.js";

// Body shape read AFTER signature verification has already succeeded (see
// `handleSlackWebhook` below). `JSON.parse` of the raw body is never invoked
// until the raw-body HMAC-SHA256 signature (constant-time compare, 5-minute
// window) has matched at least one currently configured agent's Slack
// signing secret — that is the "verify before parse/trust" boundary the
// acceptance criteria protect. Only per-team/app routing (which of the
// verified identities this specific event belongs to) happens after parsing;
// authentication itself never depends on parsed content.
interface RawSlackEnvelopeFields {
  readonly type?: string;
  readonly challenge?: string;
  readonly team_id?: string;
  readonly api_app_id?: string;
  readonly event_id?: string;
  readonly authorizations?: unknown;
  readonly event?: unknown;
}

function parseEnvelope(rawBody: string): RawSlackEnvelopeFields | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as RawSlackEnvelopeFields;
  } catch {
    return null;
  }
}

function hasTeamAuthorization(authorizations: unknown, teamId: string): boolean {
  return (
    Array.isArray(authorizations) &&
    authorizations.some((authorization) => {
      if (typeof authorization !== "object" || authorization === null) return false;
      const authorizationTeamId = (authorization as { readonly team_id?: unknown }).team_id;
      return typeof authorizationTeamId === "string" && authorizationTeamId.trim() === teamId;
    })
  );
}

export interface SlackWebhookHeaders {
  readonly [header: string]: string | string[] | undefined;
}

// HTTP header names are case-insensitive (RFC 7230 §3.2); a host that
// preserves request casing (e.g. `X-Slack-Signature`) must still match here,
// not just the exact key and its all-lowercase form. Scan every key
// case-insensitively rather than special-casing two spellings.
function readHeader(headers: SlackWebhookHeaders, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

export interface SlackAgentEventDispatch {
  readonly agentId: string;
  readonly teamId: string;
  readonly appId: string;
  readonly eventId: string;
  readonly event: unknown;
}

export interface HandleSlackWebhookDeps {
  readonly rawBody: string;
  readonly headers: SlackWebhookHeaders;
  // Injected for deterministic tests; production callers pass
  // `Math.floor(Date.now() / 1000)`.
  readonly nowEpochSeconds: number;
  // Optional millisecond clock for the rate limiter (independent precision
  // from `nowEpochSeconds`, which is seconds-granularity and used only for
  // signature/timestamp verification). Falls back to
  // `nowEpochSeconds * 1000` when omitted; production callers pass
  // `Date.now()`.
  readonly nowMs?: number;
  getProjectedIdentities(): Promise<Record<string, SlackAgentIdentity>>;
  resolveSigningSecret(agentId: string): Promise<string>;
  shouldProcessEvent(agentId: string, eventId: string): Promise<boolean>;
  onAgentEvent(dispatch: SlackAgentEventDispatch): Promise<void>;
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface SlackWebhookResponse {
  readonly status: 200 | 400 | 401 | 429;
  readonly body: unknown;
}

/**
 * Handles one inbound HTTP delivery from Slack (Events API), implementing
 * DRO-975's acceptance criteria:
 *  - route by (api_app_id, team_id) to exactly one agent; ambiguity fails closed
 *  - require Slack's authorizations list to contain that routed team; the list
 *    proves event visibility but never fans one delivery out to more agents
 *  - verify the HMAC-SHA256 request signature (constant-time compare) and the
 *    5-minute timestamp window before any event is dispatched — and before
 *    any JSON.parse of the body happens at all, for every delivery kind
 *  - deduplicate retried event_ids so Paperclip work never runs twice for the
 *    same delivery
 *  - never log or return the signing secret / any token
 *
 * Always returns HTTP 200 for anything Slack itself needs acked (including
 * "we deliberately didn't process this" cases like ambiguous routing or a
 * duplicate event_id) so Slack's own retry policy does not kick in for
 * conditions that are not transient failures. Genuine authentication
 * failures (bad/missing signature, stale timestamp) return 401. A body that
 * cannot be parsed as JSON at all returns 400. A per-team request-rate
 * excess (see rate-limit.ts) returns 429.
 *
 * Non-goals / deliberately deferred for this MVP (not silent gaps — see
 * openwiki/domain/slack-provisioning-decision.md and
 * openwiki/domain/slack-provider-mvp.md §8/§10 for the accepted rationale):
 *  - Socket Mode as an inbound transport. HTTP Events API (this handler) is
 *    the only/default transport for the MVP; Socket Mode is documented as an
 *    operator opt-in-only future option, not required here.
 *  - Channel-level authorization policy (e.g. an allow-list of channels a
 *    bot may act in) — MVP relies on Slack's own channel membership/scope
 *    boundary (bot can only see/act in channels it's invited to), same
 *    posture as the GitHub provider; see slack-provider-mvp.md §8.
 *  - A distributed/cross-process inbound rate limiter. A best-effort,
 *    in-memory, per-process, per-team fixed-window limiter is implemented
 *    (see rate-limit.ts); a multi-instance deployment's effective per-team
 *    ceiling is `limit * instanceCount` since counters are not shared across
 *    processes. Flagged for a follow-up if a distributed limiter becomes
 *    necessary, not left fully unimplemented.
 */
export async function handleSlackWebhook(deps: HandleSlackWebhookDeps): Promise<SlackWebhookResponse> {
  const { rawBody, headers, nowEpochSeconds, logger } = deps;

  // Verify the raw-body HMAC-SHA256 signature (constant-time compare,
  // 5-minute replay window) BEFORE any JSON.parse of the body happens, for
  // every kind of delivery — not just the url_verification handshake. There
  // is no per-request team_id/api_app_id to pick a single candidate secret
  // ahead of parsing (that would itself require trusting parsed content), so
  // every currently configured agent's signing secret is tried as a
  // candidate; the request is authenticated the moment any one matches. This
  // closes the gap where a routed agentId (previously read from the parsed
  // body first) was used to pick "the" secret to check against — that order
  // let an attacker's unparsed-but-well-formed JSON pick which secret
  // authenticated it. Now authentication never depends on parsed content at
  // all.
  const identities = await deps.getProjectedIdentities();
  const agentIds = Object.keys(identities);

  if (agentIds.length === 0) {
    logger.warn("Slack webhook: rejected — no configured identities to verify against");
    return { status: 401, body: { error: "unauthorized" } };
  }

  const timestampHeader = readHeader(headers, "x-slack-request-timestamp");
  const signatureHeader = readHeader(headers, "x-slack-signature");

  // Cheap, pre-secret-resolution rejection: a request missing (or with a
  // blank) signature/timestamp header can never verify against any secret
  // (verifySlackSignature rejects it for every candidate), so resolving N
  // agents' signing secrets first just to fail every one of them is wasted
  // work an unauthenticated caller can force on demand. Fail closed here,
  // before touching `resolveSigningSecret` at all.
  if (!timestampHeader || !timestampHeader.trim() || !signatureHeader || !signatureHeader.trim()) {
    logger.warn("Slack webhook: rejected — missing signature or timestamp header");
    return { status: 401, body: { error: "unauthorized" } };
  }

  const matchedAgentIds: string[] = [];
  let signingSecretResolutionFailed = false;
  for (const agentId of agentIds) {
    let candidateSecret: string;
    try {
      candidateSecret = await deps.resolveSigningSecret(agentId);
    } catch {
      // Resolution failure for one configured agent should not block
      // checking the rest. Remember the transient failure, though: if no
      // other candidate verifies, acknowledging a permanent 401 would stop
      // Slack from retrying a request that may have been valid for the
      // temporarily unavailable secret.
      signingSecretResolutionFailed = true;
      continue;
    }

    const candidateResult = verifySlackSignature({
      signingSecret: candidateSecret,
      rawBody,
      timestampHeader,
      signatureHeader,
      nowEpochSeconds,
    });

    if (candidateResult.ok) {
      matchedAgentIds.push(agentId);
    }
  }

  if (matchedAgentIds.length === 0) {
    if (signingSecretResolutionFailed) {
      logger.error("Slack webhook: signing secret resolution unavailable; delivery must be retried");
      // Deliberately generic: secret-store errors can contain provider IDs,
      // paths, or other sensitive operational detail. Rejecting the worker
      // call tells the host this was transient without echoing that detail.
      throw new Error("Slack webhook authentication is temporarily unavailable");
    }
    logger.warn("Slack webhook: signature verification failed — no configured identity matched");
    return { status: 401, body: { error: "unauthorized" } };
  }

  // Only now, with the request already authenticated against at least one
  // configured agent's secret, is it safe to parse and act on the body.
  const envelope = parseEnvelope(rawBody);
  if (!envelope) {
    logger.warn("Slack webhook: unparseable request body");
    return { status: 400, body: { error: "invalid request body" } };
  }

  // Slack's one-time Events API "Request URL" verification handshake carries
  // no team_id/api_app_id (only token/challenge/type), so there is no
  // per-team/app routing to further narrow down — the fact that the
  // signature already matched one of the configured agents' secrets above is
  // itself sufficient proof this request originated from a Slack app whose
  // secret this Paperclip instance holds.
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    return { status: 200, body: { challenge: envelope.challenge } };
  }

  const teamId = typeof envelope.team_id === "string" ? envelope.team_id : "";
  const appId = typeof envelope.api_app_id === "string" ? envelope.api_app_id : "";

  // Only Events API callbacks are dispatchable. A missing/blank event_id
  // cannot participate in deduplication, so acknowledging and dropping it is
  // safer than allowing Slack retries to create duplicate Paperclip work.
  // Likewise, Slack's authorizations list must include an installation in
  // the outer team_id. It is visibility evidence, not an alternate routing
  // source: routing remains exactly (api_app_id, team_id), and additional
  // authorizations never cause fan-out. Enterprise-only authorizations with
  // no team_id are outside the MVP's one-workspace-per-agent contract.
  const eventId = typeof envelope.event_id === "string" ? envelope.event_id.trim() : "";
  if (envelope.type !== "event_callback" || !eventId) {
    logger.warn("Slack webhook: ignored non-event callback or callback without event_id", {
      envelopeType: envelope.type,
    });
    return { status: 200, body: { ok: true, dispatched: false } };
  }
  if (!hasTeamAuthorization(envelope.authorizations, teamId.trim())) {
    logger.warn("Slack webhook: event authorizations do not include the routed team", { teamId });
    return { status: 200, body: { ok: true, dispatched: false } };
  }

  // Rate-limit per Slack team, after authentication but before routing/
  // dispatch — bounds worst-case per-process work from a single
  // flooding/misbehaving team. Best-effort/in-memory (see rate-limit.ts);
  // not a substitute for a distributed limiter, but closes the "genuinely
  // unimplemented" gap flagged in review rather than leaving it a TODO.
  if (teamId && !isWithinSlackRateLimit(teamId, deps.nowMs ?? nowEpochSeconds * 1000)) {
    logger.warn("Slack webhook: rate limit exceeded", { teamId });
    return { status: 429, body: { error: "rate limited" } };
  }

  const routeResult = routeSlackEventToAgent(identities, { appId, teamId });
  if (!routeResult.ok) {
    // Fail closed on ambiguity/no-match, but still ack — this is not a
    // transient delivery failure Slack should retry, it's a configuration
    // state (or a delivery for an app/team this Paperclip instance does not
    // manage) that retrying will never fix.
    logger.warn("Slack webhook: routing failed", { reason: routeResult.error, teamId, appId });
    return { status: 200, body: { ok: true, routed: false } };
  }

  const { agentId } = routeResult;

  // Defense in depth: the request has already been authenticated against
  // *some* configured agent's secret, but the event must also be routed to
  // an agent whose own secret is the one that actually matched — otherwise
  // agent A's valid signature could be replayed to trigger agent B's routed
  // event (a cross-agent confused-deputy risk when more than one Slack
  // identity is configured). Fail closed if the routed agent isn't among the
  // agents whose secret verified this specific request.
  if (!matchedAgentIds.includes(agentId)) {
    logger.warn("Slack webhook: routed agent's signing secret did not match this request's signature", {
      agentId,
    });
    return { status: 401, body: { error: "unauthorized" } };
  }

  const shouldProcess = await deps.shouldProcessEvent(agentId, eventId);
  if (!shouldProcess) {
    logger.info("Slack webhook: duplicate event_id skipped", { agentId, eventId });
    return { status: 200, body: { ok: true, deduplicated: true } };
  }

  await deps.onAgentEvent({
    agentId,
    teamId,
    appId,
    eventId,
    event: envelope.event,
  });

  return { status: 200, body: { ok: true } };
}
