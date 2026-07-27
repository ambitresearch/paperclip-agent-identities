/**
 * Single source of truth for the `eventsRequestUrl` envelope.
 *
 * The operator-supplied Request URL is embedded *verbatim* into the generated
 * Slack app manifest (`event_subscriptions.request_url`), and it is gated in
 * two places that must agree:
 *
 *   - the `eventsRequestUrl` config-schema `pattern` in src/manifest.ts, which
 *     guards what can be persisted to config, and
 *   - `normalizeEventsRequestUrl` in src/providers/slack/app-manifest.ts, which
 *     guards what reaches the manifest flow.
 *
 * When those two drifted apart, operators saw config that saved cleanly and
 * then threw, or -- worse, because it fails open -- values that passed the
 * runtime check and shipped a malformed manifest to Slack. Both now derive from
 * the constants here so the two cannot disagree.
 *
 * Deliberately NOT the contract: inspecting `new URL` properties. `URL`
 * normalizes where we need it to reject, and it has bitten this envelope three
 * separate times -- it percent-encodes interior whitespace instead of throwing,
 * and it reports `search`/`hash` as empty for the empty delimiters in
 * `https://host/events?` and `https://host/events#` while still preserving them
 * in `href`. The raw string is matched against the pattern instead.
 *
 * Must stay dependency-free (no node: imports): src/manifest.ts and the client
 * Settings bundle both sit downstream of this module.
 */

/**
 * HTTPS, no whitespace, query, fragment, or embedded credentials.
 *
 * The authority run `[^\s?#@/]+` excludes `@` so userinfo cannot slip through
 * (JSON Schema `format: "uri"` accepts credentials by RFC), and it stops at the
 * first `/` so the optional path may still contain `@`, which is a legal
 * `pchar`. Kept as a string because src/manifest.ts needs it as a JSON Schema
 * `pattern`; ECMA-262 semantics mean the non-capturing group is safe for Ajv,
 * and it stays RE2-safe (no lookahead, no backreferences).
 */
export const EVENTS_REQUEST_URL_PATTERN = "^https://[^\\s?#@/]+(?:/[^\\s?#]*)?$";

const eventsRequestUrlEnvelope = new RegExp(EVENTS_REQUEST_URL_PATTERN);

/** Operator-facing description of the envelope, shared by both validators. */
export const EVENTS_REQUEST_URL_REQUIREMENT =
  "eventsRequestUrl must be an HTTPS URL with no whitespace, query, fragment, or embedded credentials.";

/** True when the raw string satisfies the envelope above. */
export function matchesEventsRequestUrlEnvelope(value: string): boolean {
  return eventsRequestUrlEnvelope.test(value);
}
