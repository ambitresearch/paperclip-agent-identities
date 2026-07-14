// Lightweight, best-effort, in-memory (non-distributed) inbound rate limiter
// for the Slack Events API ingress endpoint. Deliberately simple: a
// fixed-window counter per key, reset once the window elapses. This is not a
// substitute for a distributed limiter (each worker process tracks its own
// counters, so a multi-instance deployment's effective per-team limit is
// `limit * instanceCount`), but it bounds worst-case per-process work for a
// single misbehaving/duplicate-flooding Slack team or app, which is the
// concrete risk this MVP needs covered — see
// openwiki/domain/slack-provisioning-decision.md's rate-limiting deferral.
//
// Keyed by team_id (not agentId) so a flood aimed at one Slack workspace
// cannot be laundered through routing ambiguity/misconfiguration to exhaust
// a different agent's budget.

export interface SlackRateLimitConfig {
  readonly limit: number;
  readonly windowMs: number;
}

const DEFAULT_CONFIG: SlackRateLimitConfig = {
  limit: 30,
  windowMs: 10_000, // 30 requests / 10s per team — generous for normal traffic, bounds floods.
};

interface WindowState {
  count: number;
  windowStartMs: number;
}

const windows = new Map<string, WindowState>();

/**
 * Returns `true` if the request identified by `key` (the Slack team_id) is
 * within the allowed rate, incrementing its counter as a side effect.
 * Returns `false` once the configured limit is exceeded within the current
 * window — callers should reject with 429 rather than process the request.
 *
 * `nowMs` is injectable for deterministic tests; production callers pass
 * `Date.now()`.
 */
export function isWithinSlackRateLimit(
  key: string,
  nowMs: number,
  config: SlackRateLimitConfig = DEFAULT_CONFIG
): boolean {
  const existing = windows.get(key);

  if (!existing || nowMs - existing.windowStartMs >= config.windowMs) {
    windows.set(key, { count: 1, windowStartMs: nowMs });
    return true;
  }

  if (existing.count >= config.limit) {
    return false;
  }

  existing.count += 1;
  return true;
}

/** Test-only: clears all in-memory rate-limit state between test cases. */
export function resetSlackRateLimitState(): void {
  windows.clear();
}
