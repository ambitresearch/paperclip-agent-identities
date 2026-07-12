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
}

export type VerifySlackToken = (token: string) => Promise<VerifiedSlackTokenIdentity>;

/**
 * Verifies a resolved Slack bot token against Slack's own `auth.test`
 * endpoint, returning the *real* workspace (team) that token authenticates
 * as. Defaults to a live network call — callers resolving credentials in
 * tests should inject a fake/mock implementation instead (see
 * `resolveSlackBotToken`'s `verifyToken` parameter).
 *
 * Fails closed: any non-2xx response, a `{ ok: false }` body, or a missing
 * `team_id` throws rather than returning a fallback identity.
 */
export async function verifySlackToken(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<VerifiedSlackTokenIdentity> {
  const response = await fetchImpl("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await response.json().catch(() => ({})) as { ok?: unknown; team_id?: unknown; error?: unknown };
  if (!response.ok || body.ok !== true || typeof body.team_id !== "string" || !body.team_id.trim()) {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(`Slack token verification failed: ${reason}`);
  }

  return { teamId: body.team_id };
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
 * a rejected secret resolution (e.g. a revoked token), or a resolved token
 * whose real workspace does not match the configured identity — there is no
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

  // Verify the resolved token's real workspace before ever returning it. No
  // operator-identity fallback on mismatch, matching this file's other
  // fail-closed paths.
  const verifiedIdentity = await verifyToken(token);
  assertSlackWorkspaceMatch(resolvedIdentity.identity, verifiedIdentity.teamId);

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
