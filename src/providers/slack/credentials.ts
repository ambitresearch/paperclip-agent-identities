import type { CredentialResolverInput, ResolvedCredential } from "../../core/provider-contract.js";
import type { ResolvedAgentIdentity } from "../../core/agent-identity.js";
import { readSidecarIdentityForProvider, resolveCredentialSidecarPath, type ResolveSecret } from "../../credential-sidecar.js";
import type { SlackAgentIdentity } from "./config.js";

const SLACK_PROVIDER_ID = "slack" as const;

export interface ResolvedSlackBotToken {
  readonly token: string;
  readonly secrets: readonly string[];
}

/**
 * Resolves the Slack bot token (and, if configured, the signing secret) for
 * an agent's Slack identity from the credential sidecar. Mirrors
 * `resolveIdentityToken` for GitHub but is a deliberately separate function —
 * per openwiki/domain/slack-provider-mvp.md §2/§14, Slack has no `tokenFile`
 * fallback (a signing secret must never be written to disk the way a GitHub
 * PEM is) and MVP disables rotation entirely, so there is no shared
 * multi-source resolution branch to fold Slack into.
 *
 * Fails closed (throws) on: missing sidecar entry, malformed sidecar entry,
 * or a rejected secret resolution (e.g. a revoked token) — there is no
 * operator-identity or other fallback path.
 */
export async function resolveSlackBotToken(
  resolvedIdentity: ResolvedAgentIdentity<SlackAgentIdentity>,
  resolveSecret: ResolveSecret
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

  const { botTokenSecretId, signingSecretId } = sidecarIdentity.slackBotToken;

  // Resolve the bot token first — let a rejection (e.g. revoked secret)
  // propagate untouched, with no fallback.
  const token = await resolveSecret(botTokenSecretId);

  const secrets: string[] = [token];
  if (signingSecretId) {
    const signingSecret = await resolveSecret(signingSecretId);
    secrets.push(signingSecret);
  }

  return { token, secrets };
}

/**
 * Fail-closed guard against cross-workspace credential misuse (see
 * openwiki/domain/slack-provider-mvp.md §9, "Cross-workspace IDs"). Exported
 * for the tool-implementing issues (DRO-971/973/974/975) to call once a
 * `SlackChannelRef.teamId` is available, so a wrong-workspace channel ref can
 * never be used against a mismatched identity's token.
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
