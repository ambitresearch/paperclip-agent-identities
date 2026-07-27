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
 * runtime check and shipped a malformed manifest to Slack.
 *
 * The root cause was never the individual checks: it was that each side ran a
 * *different* URL validator. The config path applied Ajv's RFC 3986
 * `format: "uri"`, the runtime path applied WHATWG `new URL()`, and those two
 * disagree in both directions. WHATWG silently normalizes what RFC rejects
 * outright -- a backslash becomes a slash, non-ASCII hosts become punycode, and
 * `| { } ^ " < >` plus malformed `%` escapes are percent-encoded rather than
 * refused -- while RFC's bare `port = *DIGIT` accepts `:99999` and `:notaport`,
 * which WHATWG refuses. Sharing only the pattern left both of those halves
 * unshared, so 11 of 13 probe cases still drifted.
 *
 * Neither validator is used any more. The pattern below is precise enough to be
 * the *sole* discriminator on both paths: every string it accepts is accepted by
 * RFC 3986 `format: "uri"` and also parses under WHATWG `new URL()`.
 * tests/shared/events-request-url.spec.ts proves that containment by sweeping
 * every ASCII code point through the host and path positions, so this comment
 * cannot quietly rot. Because both sides now apply this one expression and
 * nothing else, they cannot disagree by construction.
 *
 * Corollary for future edits: do not add a second check to either side. If this
 * envelope needs to change, change the pattern.
 *
 * Must stay dependency-free (no node: imports): src/manifest.ts and the client
 * Settings bundle both sit downstream of this module.
 */

/**
 * RFC 3986 `unreserved` + `sub-delims` -- the characters legal in a `reg-name`.
 *
 * Deliberately an allowlist. Every drift bug this envelope has had came from a
 * denylist missing a character, which fails *open*; an allowlist fails closed.
 * Note the absences: `@` (so userinfo cannot slip through -- RFC accepts
 * credentials), `/` (so the authority run stops at the path), and `%` (WHATWG
 * treats it as a forbidden domain code point and throws, while RFC accepts it).
 */
const HOST_CHARS = "A-Za-z0-9\\-._~!$&'()*+,;=";

/** RFC 3986 `pchar` plus `/`: `unreserved` / `sub-delims` / `:` / `@`. */
const PATH_CHARS = "A-Za-z0-9\\-._~!$&'()*+,;=:@/";

/**
 * Optional `:port`, 1-65535 with no leading zeros.
 *
 * Spelled out rather than `\d{1,5}` because RFC 3986's `port = *DIGIT` puts no
 * bound on the value while WHATWG does: `:99999` is valid to Ajv and throws in
 * `new URL`. This is the ugly half of keeping the two aligned.
 */
const PORT = "(?::(?:6553[0-5]|655[0-2]\\d|65[0-4]\\d{2}|6[0-4]\\d{3}|[1-5]\\d{4}|[1-9]\\d{0,3}))?";

/**
 * HTTPS origin, optional bounded port, optional path of `pchar`/`%XX`.
 *
 * Kept as a string because src/manifest.ts needs it as a JSON Schema `pattern`.
 * RE2-safe: no lookahead and no backreferences. It also cannot backtrack
 * catastrophically -- `%` is absent from PATH_CHARS, so the two path
 * alternatives are disjoint and each character has exactly one parse.
 */
export const EVENTS_REQUEST_URL_PATTERN =
  `^https://[${HOST_CHARS}]+${PORT}(?:/(?:[${PATH_CHARS}]|%[0-9A-Fa-f]{2})*)?$` as const;

const eventsRequestUrlEnvelope = new RegExp(EVENTS_REQUEST_URL_PATTERN);

/** Operator-facing description of the envelope, shared by both validators. */
export const EVENTS_REQUEST_URL_REQUIREMENT =
  "eventsRequestUrl must be an HTTPS URL with no query, fragment, or embedded credentials, using only characters that are valid in a URI.";

/** True when the raw string satisfies the envelope above. */
export function matchesEventsRequestUrlEnvelope(value: string): boolean {
  return eventsRequestUrlEnvelope.test(value);
}
