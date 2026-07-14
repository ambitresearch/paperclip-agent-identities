import type { CredentialResolverInput, ResolvedCredential } from "../../core/provider-contract.js";
import type { ResolvedAgentIdentity } from "../../core/agent-identity.js";
import { readSidecarIdentityForProvider, resolveCredentialSidecarPath, type ResolveSecret } from "../../credential-sidecar.js";
import type { SlackAgentIdentity } from "./config.js";

const SLACK_PROVIDER_ID = "slack" as const;

export interface ResolvedSlackBotToken {
  readonly token: string;
  readonly secrets: readonly string[];
}

export interface VerifiedSlackTokenIdentity {
  readonly teamId: string;
  /** The Slack user ID the token authenticates as (bot or human user). */
  readonly userId: string;
  /**
   * Present only for bot tokens. A human/user OAuth token whose team_id and
   * user_id happen to match a bot identity still omits `bot_id` — that gap
   * is exactly what lets `resolveSlackBotToken` reject it below (see T2 in
   * openwiki/domain/slack-provider-design.md).
   */
  readonly botId: string | undefined;
}

export type VerifySlackToken = (token: string) => Promise<VerifiedSlackTokenIdentity>;

/**
 * Verifies a resolved Slack bot token against Slack's own `auth.test`
 * endpoint, returning the *real* workspace (team), user, and bot identity
 * that token authenticates as. Defaults to a live network call — callers
 * resolving credentials in tests should inject a fake/mock implementation
 * instead (see `resolveSlackBotToken`'s `verifyToken` parameter).
 *
 * Fails closed: any non-2xx response, a `{ ok: false }` body, or a missing
 * `team_id`/`user_id` throws rather than returning a fallback identity. Does
 * NOT itself require `bot_id` — that check is threat-model-specific (reject
 * user tokens) and lives in `resolveSlackBotToken`, so this function stays a
 * faithful, unopinionated mirror of `auth.test`.
 */
export async function verifySlackToken(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<VerifiedSlackTokenIdentity> {
  const response = await fetchImpl("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await response.json().catch(() => ({})) as {
    ok?: unknown;
    team_id?: unknown;
    user_id?: unknown;
    bot_id?: unknown;
    error?: unknown;
  };
  if (
    !response.ok ||
    body.ok !== true ||
    typeof body.team_id !== "string" ||
    !body.team_id.trim() ||
    typeof body.user_id !== "string" ||
    !body.user_id.trim()
  ) {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(`Slack token verification failed: ${reason}`);
  }

  return {
    teamId: body.team_id,
    userId: body.user_id,
    botId: typeof body.bot_id === "string" && body.bot_id.trim() ? body.bot_id : undefined,
  };
}

/**
 * Resolves the Slack bot token for an agent's Slack identity from the
 * credential sidecar, then verifies the resolved token's *actual* workspace
 * matches the configured identity's `teamId` before ever returning it. This
 * closes the gap where `assertSlackWorkspaceMatch` alone only checks a
 * resource ref's teamId against the identity, and never checks the real
 * resolved token. Mirrors `resolveIdentityToken` for GitHub but is a
 * deliberately separate function — per openwiki/domain/slack-provider-mvp.md
 * §2/§14, Slack has no `tokenFile` fallback (a signing secret must never be
 * written to disk the way a GitHub PEM is) and MVP disables rotation
 * entirely, so there is no shared multi-source resolution branch to fold
 * Slack into.
 *
 * Deliberately does NOT resolve the signing secret — that is only needed for
 * inbound Events API request verification (deferred work, not part of
 * outbound/tool credential resolution). See `resolveSlackSigningSecret`.
 *
 * Fails closed (throws) on: missing sidecar entry, malformed sidecar entry,
 * a rejected secret resolution (e.g. a revoked token), a resolved token
 * whose real workspace does not match the configured identity, a resolved
 * token whose real user does not match the identity's configured
 * `botUserId`, or a resolved token missing `bot_id` (i.e. a human/user OAuth
 * token, even one whose team_id/user_id happen to match) — there is no
 * operator-identity or other fallback path. Error messages never include the
 * resolved token value.
 */
export async function resolveSlackBotToken(
  resolvedIdentity: ResolvedAgentIdentity<SlackAgentIdentity>,
  resolveSecret: ResolveSecret,
  verifyToken: VerifySlackToken = verifySlackToken
): Promise<ResolvedSlackBotToken> {
  const sidecarPath = await resolveCredentialSidecarPath();
  const sidecarIdentity = await readSidecarIdentityForProvider(
    resolvedIdentity.agentId,
    SLACK_PROVIDER_ID,
    sidecarPath
  );

  if (!sidecarIdentity.slackBotToken) {
    throw new Error(
      `Missing Slack bot token credential for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId}:slack.slackBotToken in ${sidecarPath}.`
    );
  }

  const { botTokenSecretId } = sidecarIdentity.slackBotToken;

  // Resolve the bot token first — let a rejection (e.g. revoked secret)
  // propagate untouched, with no fallback.
  const token = await resolveSecret(botTokenSecretId);

  // Verify the resolved token's real workspace, user, and bot-ness before
  // ever returning it. No operator-identity fallback on any mismatch,
  // matching this file's other fail-closed paths. This is the T2 mitigation
  // from openwiki/domain/slack-provider-design.md: a same-workspace user
  // token, or another bot's token, must never satisfy this check.
  const verifiedIdentity = await verifyToken(token);
  assertSlackWorkspaceMatch(resolvedIdentity.identity, verifiedIdentity.teamId);

  if (!verifiedIdentity.botId) {
    throw new Error(
      `Slack credential rejected: resolved token has no bot_id (not a bot token) for agent '${resolvedIdentity.agentId}'.`
    );
  }

  if (verifiedIdentity.userId !== resolvedIdentity.identity.botUserId) {
    throw new Error(
      `Slack credential rejected: resolved token's user does not match the configured botUserId for agent '${resolvedIdentity.agentId}'.`
    );
  }

  return { token, secrets: [token] };
}

/**
 * Resolves the Slack signing secret for an agent's Slack identity from the
 * credential sidecar. Deliberately kept separate from `resolveSlackBotToken`
 * and NOT wired into outbound/tool credential resolution — the signing
 * secret is only needed for inbound Events API request verification
 * (`X-Slack-Signature` / `X-Slack-Request-Timestamp`), which is deferred
 * work per openwiki/domain/slack-provider-mvp.md. Exported for that future
 * inbound-verification work to call directly.
 *
 * Fails closed (throws) when no signing secret is configured for the agent.
 */
export async function resolveSlackSigningSecret(
  resolvedIdentity: ResolvedAgentIdentity<SlackAgentIdentity>,
  resolveSecret: ResolveSecret
): Promise<string> {
  const sidecarPath = await resolveCredentialSidecarPath();
  const sidecarIdentity = await readSidecarIdentityForProvider(
    resolvedIdentity.agentId,
    SLACK_PROVIDER_ID,
    sidecarPath
  );

  if (!sidecarIdentity.slackBotToken) {
    throw new Error(
      `Missing Slack bot token credential for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId}:slack.slackBotToken in ${sidecarPath}.`
    );
  }

  const { signingSecretId } = sidecarIdentity.slackBotToken;
  if (!signingSecretId) {
    throw new Error(
      `Missing Slack signing secret credential for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId}:slack.slackBotToken.signingSecretId in ${sidecarPath}.`
    );
  }

  return resolveSecret(signingSecretId);
}

/**
 * Fail-closed guard against cross-workspace credential misuse (see
 * openwiki/domain/slack-provider-mvp.md §9, "Cross-workspace IDs"). Exported
 * for the tool-implementing issues (DRO-971/973/974/975) to call once a
 * `SlackChannelRef.teamId` is available, so a wrong-workspace channel ref can
 * never be used against a mismatched identity's token. Also used internally
 * by `resolveSlackBotToken` to check a resolved token's *real* verified
 * workspace against the configured identity.
 */
export function assertSlackWorkspaceMatch(identity: SlackAgentIdentity, expectedTeamId: string): void {
  if (identity.teamId !== expectedTeamId) {
    throw new Error(
      `Slack workspace mismatch: identity is bound to team '${identity.teamId}' but expected '${expectedTeamId}'.`
    );
  }
}

export async function resolveSlackCredential(
  input: CredentialResolverInput<SlackAgentIdentity>
): Promise<ResolvedCredential> {
  const { identity, ctx } = input;
  const resolveSecret = (secretRef: string) => ctx.secrets.resolve(secretRef);
  const { token, secrets } = await resolveSlackBotToken(identity, resolveSecret);
  return { token, secrets };
}
