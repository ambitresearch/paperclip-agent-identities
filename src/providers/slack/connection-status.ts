import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "../../core/agent-identity.js";
import { resolveSlackBotToken, verifySlackToken, type ResolveSlackSecret } from "./credentials.js";
import { readSlackIdentityConfigEntry, validateSlackConfig, type SlackAgentIdentity } from "./config.js";

/**
 * DRO-1161: a bounded, secret-free "Connection" health check, distinct from
 * `slack_bot_whoami` (which only echoes already-stored, unverified public
 * metadata — see tools/whoami.ts). This module performs a live Slack
 * `auth.test` against the resolved bot credential and reports only
 * bounded, non-secret outcome metadata: never the token, never raw Slack
 * response bodies beyond the safe error code already returned by
 * `verifySlackToken`/`resolveSlackBotToken`.
 *
 * Reuses `resolveSlackBotToken`'s existing fail-closed checks (workspace
 * match, bot-token-not-user-token, botUserId match) so "Connection: ok"
 * means exactly what tool/reply credential resolution would also accept —
 * no separate, weaker notion of "connected".
 */

export type SlackConnectionCheckOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Safe, bounded error category — never a raw Slack error string or stack trace. */
      readonly category: SlackConnectionFailureCategory;
      /** Short, non-secret human-readable reason (bounded length, no token/header content). */
      readonly reason: string;
    };

export type SlackConnectionFailureCategory =
  | "credential_missing"
  | "credential_resolution_failed"
  | "auth_test_failed"
  | "workspace_mismatch"
  | "identity_mismatch"
  | "timeout"
  | "unknown";

export interface SlackConnectionCheckResult {
  readonly outcome: SlackConnectionCheckOutcome;
  /** ISO-8601 timestamp of when this check ran. */
  readonly checkedAt: string;
  /** Next-step guidance for the operator, present only on failure. */
  readonly nextStep?: string;
}

const SLACK_CONNECTION_CHECK_TIMEOUT_MS = 8_000;

const CONNECTION_FAILURE_GUIDANCE: Record<SlackConnectionFailureCategory, string> = {
  credential_missing:
    "No bot token secret reference is configured for this identity yet. Complete Slack App setup and save install metadata.",
  credential_resolution_failed:
    "The configured bot token secret reference could not be resolved (it may be missing, revoked, or deleted). Re-check the secret reference in the Slack App setup step.",
  auth_test_failed:
    "Slack rejected the resolved bot token (auth.test failed). Reinstall the Slack App or rotate the bot token, then update the stored secret reference.",
  workspace_mismatch:
    "The resolved bot token authenticates to a different Slack workspace than this identity is configured for. Verify the correct token is bound to this identity.",
  identity_mismatch:
    "The resolved bot token's user/bot identity does not match the configured bot user ID. Re-run Slack App discovery to refresh the stored identity metadata.",
  timeout:
    "The live Slack credential check did not complete in time. This may be transient network/API latency; retry the check.",
  unknown:
    "An unexpected error occurred while checking the Slack connection. Retry the check; if it persists, contact support.",
};

function categorizeConnectionError(error: unknown): { category: SlackConnectionFailureCategory; reason: string } {
  const message = error instanceof Error ? error.message : "Unknown error";
  if (message.includes("workspace mismatch")) {
    return { category: "workspace_mismatch", reason: "Resolved token's workspace does not match the configured identity." };
  }
  if (message.includes("no bot_id") || message.includes("does not match the configured botUserId")) {
    return { category: "identity_mismatch", reason: "Resolved token's identity does not match the configured bot user." };
  }
  if (message.includes("token verification failed")) {
    return { category: "auth_test_failed", reason: "Slack auth.test rejected the resolved bot token." };
  }
  if (message.includes("Missing or invalid Slack botToken secret reference")) {
    return { category: "credential_missing", reason: "No bot token secret reference is configured." };
  }
  if (message.includes("timed out") || message.includes("aborted")) {
    return { category: "timeout", reason: "The live credential check timed out." };
  }
  return { category: "credential_resolution_failed", reason: "The bot token secret reference could not be resolved." };
}

/**
 * Runs a single bounded live Slack `auth.test` check for the resolved
 * identity's bot token. Never returns the token itself; the caller (a
 * settings action) must not thread `token`/`secrets` back to the UI. Bounds
 * the check with a timeout so a slow/hanging Slack API call cannot hang the
 * settings action indefinitely.
 */
export async function runSlackConnectionCheck(
  resolvedIdentity: ResolvedAgentIdentity<SlackAgentIdentity>,
  config: Record<string, unknown>,
  companyId: string,
  resolveSecret: ResolveSlackSecret,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<SlackConnectionCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    await withTimeout(
      resolveSlackBotToken(
        resolvedIdentity,
        config,
        companyId,
        resolveSecret,
        (token) => verifySlackToken(token, fetchImpl),
      ),
      SLACK_CONNECTION_CHECK_TIMEOUT_MS,
    );
    return { outcome: { ok: true }, checkedAt };
  } catch (error) {
    const { category, reason } = categorizeConnectionError(error);
    return {
      outcome: { ok: false, category, reason },
      checkedAt,
      nextStep: CONNECTION_FAILURE_GUIDANCE[category],
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Slack connection check timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const SLACK_CONNECTION_CHECK_ACTION = "check-slack-connection";

/**
 * Registers the `check-slack-connection` settings action: a human-actor-gated,
 * company-scoped, bounded live Slack `auth.test` check. Returns only bounded
 * outcome metadata (ok/category/reason/checkedAt/nextStep) — never the
 * resolved token, never a raw Slack response body.
 */
export function contributeSlackConnectionStatusAction(ctx: PluginContext): void {
  ctx.actions.register(SLACK_CONNECTION_CHECK_ACTION, async (params, context) => {
    const agentId = typeof params.agentId === "string" ? params.agentId.trim() : "";
    if (!agentId) {
      throw new Error("agentId is required to check the Slack connection.");
    }
    const companyId = typeof context.companyId === "string" ? context.companyId.trim() : "";
    if (!companyId) {
      throw new Error("A host-authorized companyId is required to check the Slack connection.");
    }

    const config = await ctx.config.get(companyId);
    const entry = readSlackIdentityConfigEntry(config, agentId);
    const validated = entry ? validateSlackConfig(entry.value) : undefined;
    if (!entry || !validated || typeof validated === "string") {
      const checkedAt = new Date().toISOString();
      return {
        outcome: { ok: false, category: "credential_missing", reason: "No Slack identity is configured for this agent." },
        checkedAt,
        nextStep: CONNECTION_FAILURE_GUIDANCE.credential_missing,
      };
    }

    const resolvedIdentity: ResolvedAgentIdentity<SlackAgentIdentity> = { agentId, identity: validated };
    const runCtx: ToolRunContext = { agentId, runId: `settings-connection-check:${agentId}`, companyId, projectId: "" };
    void runCtx;

    return runSlackConnectionCheck(
      resolvedIdentity,
      config,
      companyId,
      (secretRef, options) => ctx.secrets.resolve(secretRef, options),
      ctx.http.fetch,
    );
  });
}
