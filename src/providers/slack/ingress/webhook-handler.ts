import { verifySlackSignature } from "./signature.js";
import { routeSlackEventToAgent } from "./routing.js";
import type { SlackAgentIdentity } from "../config.js";

// Minimal, pre-verification-safe shape extraction. Parsing JSON to read a
// handful of top-level string fields does not execute any code and does not
// trust the content semantically — it only recovers the (team_id, api_app_id)
// pair needed to look up *which* per-agent Slack app signing secret to verify
// the signature against, since each Paperclip agent has its own separate
// Slack app/signing secret (openwiki/domain/slack-provider-design.md §1) and
// this MVP exposes one shared ingress endpoint rather than a distinct URL per
// agent. No field read here is acted upon, persisted, or dispatched until the
// HMAC signature over the *raw, untouched* body has been verified below —
// that is the "before parsing" boundary the acceptance criteria protect:
// never trust event content, never resolve credentials, never dispatch to
// agent business logic ahead of signature verification.
interface RawSlackEnvelopeFields {
  readonly type?: string;
  readonly challenge?: string;
  readonly team_id?: string;
  readonly api_app_id?: string;
  readonly event_id?: string;
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

export interface SlackWebhookHeaders {
  readonly [header: string]: string | string[] | undefined;
}

function readHeader(headers: SlackWebhookHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export interface SlackAgentEventDispatch {
  readonly agentId: string;
  readonly teamId: string;
  readonly appId: string;
  readonly eventId: string | undefined;
  readonly event: unknown;
}

export interface HandleSlackWebhookDeps {
  readonly rawBody: string;
  readonly headers: SlackWebhookHeaders;
  // Injected for deterministic tests; production callers pass
  // `Math.floor(Date.now() / 1000)`.
  readonly nowEpochSeconds: number;
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
  readonly status: 200 | 400 | 401;
  readonly body: unknown;
}

/**
 * Handles one inbound HTTP delivery from Slack (Events API), implementing
 * DRO-975's acceptance criteria:
 *  - route by (api_app_id, team_id) to exactly one agent; ambiguity fails closed
 *  - verify the HMAC-SHA256 request signature (constant-time compare) and the
 *    5-minute timestamp window before any event is dispatched
 *  - deduplicate retried event_ids so Paperclip work never runs twice for the
 *    same delivery
 *  - never log or return the signing secret / any token
 *
 * Always returns HTTP 200 for anything Slack itself needs acked (including
 * "we deliberately didn't process this" cases like ambiguous routing or a
 * duplicate event_id) so Slack's own retry policy does not kick in for
 * conditions that are not transient failures. Genuine authentication
 * failures (bad/missing signature, stale timestamp) return 401. A body that
 * cannot be parsed as JSON at all returns 400.
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
 *  - A dedicated inbound rate limiter for this webhook path. TODO: no
 *    per-agent or per-team rate limiting is implemented on this ingress
 *    endpoint today; if abusive/duplicate traffic volume becomes a concern,
 *    add a lightweight in-memory (best-effort, non-distributed) limiter here.
 *    Flagged for a follow-up rather than added speculatively/untested in
 *    this pass.
 */
export async function handleSlackWebhook(deps: HandleSlackWebhookDeps): Promise<SlackWebhookResponse> {
  const { rawBody, headers, nowEpochSeconds, logger } = deps;

  const envelope = parseEnvelope(rawBody);
  if (!envelope) {
    logger.warn("Slack webhook: unparseable request body");
    return { status: 400, body: { error: "invalid request body" } };
  }

  // Slack's one-time Events API "Request URL" verification handshake carries
  // no team_id/api_app_id (only token/challenge/type), so the normal
  // per-team/app routing cannot pick a single signing secret to check it
  // against. That is NOT a license to skip verification: unsigned
  // url_verification requests must still be rejected (401), never trusted.
  // Instead, verify the raw-body HMAC (constant-time, 5-minute window)
  // against *every currently configured agent's* Slack signing secret and
  // accept if it matches any one of them — the handshake is legitimately
  // asking "does some signing secret I hold match this request?" and any
  // configured identity answering yes is sufficient proof this request
  // originated from a Slack app whose secret this Paperclip instance holds.
  // If no identities are configured yet, fail closed (401) rather than
  // accept an unsigned/unverifiable handshake.
  if (envelope.type === "url_verification" && typeof envelope.challenge === "string") {
    const identities = await deps.getProjectedIdentities();
    const agentIds = Object.keys(identities);

    if (agentIds.length === 0) {
      logger.warn("Slack webhook: url_verification rejected — no configured identities to verify against");
      return { status: 401, body: { error: "unauthorized" } };
    }

    const timestampHeader = readHeader(headers, "x-slack-request-timestamp");
    const signatureHeader = readHeader(headers, "x-slack-signature");

    for (const agentId of agentIds) {
      let candidateSecret: string;
      try {
        candidateSecret = await deps.resolveSigningSecret(agentId);
      } catch {
        // Resolution failure for one configured agent should not block
        // checking the rest — just skip this candidate.
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
        return { status: 200, body: { challenge: envelope.challenge } };
      }
    }

    logger.warn("Slack webhook: url_verification rejected — signature did not match any configured identity");
    return { status: 401, body: { error: "unauthorized" } };
  }

  const teamId = typeof envelope.team_id === "string" ? envelope.team_id : "";
  const appId = typeof envelope.api_app_id === "string" ? envelope.api_app_id : "";

  const identities = await deps.getProjectedIdentities();
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

  let signingSecret: string;
  try {
    signingSecret = await deps.resolveSigningSecret(agentId);
  } catch (error) {
    logger.error("Slack webhook: signing secret resolution failed", {
      agentId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return { status: 401, body: { error: "unauthorized" } };
  }

  const signatureResult = verifySlackSignature({
    signingSecret,
    rawBody,
    timestampHeader: readHeader(headers, "x-slack-request-timestamp"),
    signatureHeader: readHeader(headers, "x-slack-signature"),
    nowEpochSeconds,
  });

  if (!signatureResult.ok) {
    // Never include the reason's underlying secret/token — verifySlackSignature
    // never puts either in its error message, but assert the discipline here
    // too via the response shape (a fixed, generic body, not the raw error).
    logger.warn("Slack webhook: signature verification failed", { agentId });
    return { status: 401, body: { error: "unauthorized" } };
  }

  const eventId = typeof envelope.event_id === "string" ? envelope.event_id : undefined;
  if (eventId) {
    const shouldProcess = await deps.shouldProcessEvent(agentId, eventId);
    if (!shouldProcess) {
      logger.info("Slack webhook: duplicate event_id skipped", { agentId, eventId });
      return { status: 200, body: { ok: true, deduplicated: true } };
    }
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
