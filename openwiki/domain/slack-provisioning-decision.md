# Slack app manifests and per-agent provisioning — decision record

Status: **decided and implemented for HTTP Events API**. Generated manifests require an
HTTPS URL with no query, fragment, or embedded credentials, set it as the Slack Request URL, and
subscribe to `message.im`, `app_mention`, `message.channels`, `message.groups`, and
`message.mpim`. Socket Mode remains an unimplemented,
operator-opt-in future transport.

## Decision

- **One Slack app + one bot user per Paperclip agent.** Slack bot identity attribution is
  per-app: a bot token authenticates as *that app's* bot user, so distinct visible names/avatars
  in Slack require distinct apps, not distinct tokens off one app. This is the load-bearing fact
  that shapes everything below.
  Source: [Enabling interactions with bots](https://api.slack.com/bot-users) (bot users belong to
  one app each); [Differences between bot and user tokens](https://api.slack.com/authentication/token-types#bot).
- **MVP install path: manual copy/paste manifest, operator-driven, per agent.** For each agent,
  our plugin generates the manifest JSON and a plain link to `https://api.slack.com/apps?new_app=1`.
  Slack does **not** support a documented query parameter that prefills the manifest on that page
  (there is no `manifest_json` param in Slack's app-manifest reference) — the operator opens the
  link, chooses "From an app manifest," pastes in the JSON our plugin generated, reviews what
  Slack renders, picks the target workspace, and clicks **Create**. Slack then walks the operator
  through installing the app to the workspace, which exposes the bot token and signing secret.
  This install sequence itself requires no Slack credential inside Paperclip's config, workspace,
  or logs. The operator creates one Paperclip company secret for the bot token and another for the
  signing secret, then supplies both secret UUIDs to the settings form. Saving install metadata
  stores typed `secret_ref` values under
  `identities.<agentId>.slack.credentials.{botToken,signingSecret}` in company-scoped host config. Raw
  credential values never enter identity state or action input.
  Source: [App manifests overview](https://api.slack.com/reference/manifests) (the "From an app
  manifest" creation flow is UI paste-in; no query-string prefill parameter is documented).
- **Event transport: HTTP Events API (Request URL), not Socket Mode.** Rejected Socket Mode for
  the default path — see rationale below. Socket Mode remains an optional advanced mode for
  operators who cannot expose a public HTTPS endpoint, but is not implemented by DRO-1005/PR #81.
- **App Manifest APIs (`apps.manifest.*`) are an optional operator-only automation path**, not
  part of the default agent-facing flow, because they require a rotating, short-lived
  configuration token that itself needs secure storage and periodic refresh. Using them at all
  is a product decision to trade a small amount of operator convenience for holding another
  credential; the default path (manifest deep link) needs none.

## Why HTTP only in the implemented slice

| Concern | HTTP Events API | Socket Mode |
| --- | --- | --- |
| Transport | Slack POSTs events to a public HTTPS Request URL | App opens an outbound WebSocket via `apps.connections.open` |
| Credential needed | Signing secret (verify `X-Slack-Signature` / `X-Slack-Request-Timestamp`) | App-level token (`xapp-...`, `connections:write` scope); events are authenticated via that token over the WebSocket, not HTTP request-signature verification, so the signing secret is not itself a Socket Mode transport credential |
| Marketplace / distribution | Supported for public distribution | **Not supported for Slack Marketplace apps** |
| Infra requirement | Needs a reachable HTTPS endpoint | No public endpoint needed; app dials out |
| Reconnect/ack model | Standard HTTP 200 ack within 3s; retries on non-2xx/timeout | Must ack each message over the socket and handle `disconnect`/reconnect frames, hello, and periodic re-opens |

At the time of this decision, the Paperclip-hosted worker exposed no provider webhook seam, so a
public Events API receiver was an implementation prerequisite. DRO-1005 added that HTTP ingress
composition path. The current manifest builder now accepts any public HTTPS Request URL and
subscribes the generated app to direct messages, app mentions, and channel thread messages.
Socket Mode remains separate
follow-up work.

The Socket Mode acceptance bullet that appeared in linked GitHub issue #62 combined two transports
despite this record selecting HTTP. It is explicitly deferred to separate work: an implementation
would need operator-side `xapp-...` token custody, per-envelope WebSocket acknowledgements,
`disconnect`/reconnect handling, and connection refresh without logging tokens or WebSocket URLs.
None of those behaviors is claimed by DRO-1005/PR #81.

Sources:
[Using Socket Mode](https://api.slack.com/apis/socket-mode) (app-level token requirement,
`connections:write`, Marketplace restriction, ack/reconnect semantics);
[The Events API](https://api.slack.com/apis/events-api) (Request URL verification, 3-second ack
window, retry behavior); [Verifying requests from Slack](https://api.slack.com/authentication/verifying-requests-from-slack)
(signing secret + timestamp signature scheme).

## App Manifest APIs — evaluated, kept optional

`apps.manifest.create` / `apps.manifest.update` / `apps.manifest.export` /
`apps.manifest.validate` let an operator script app creation instead of clicking through the
manifest deep link. They authenticate with an **app configuration token**:

- Configuration tokens are minted via `tooling.tokens.rotate` (or the "Generate Tokens" panel) and
  expire in **12 hours**.
- Each rotation also returns a **configuration refresh token** with no fixed expiry, used to mint
  the next 12-hour access token — the refresh token itself must be stored securely and rotates
  each use (old refresh token is invalidated).
- These tokens are organization/user-scoped credential material, squarely inside this
  repository's "never place in agent config, workspaces, tool output, issue comments, logs, or
  git" rule.

Decision: keep this path **available but off by default**, documented for an operator who wants
to script bulk app creation for many agents at once. Its configuration tokens must live in an
operator-only credential store, never agent config, and must not be touched by agent-facing tools.
The default per-agent flow needs none of this and is preferred for that reason alone.

Source: [App Manifest APIs / Configuration tokens](https://api.slack.com/reference/manifests#config-tokens).

## Minimum bot scopes

| Capability | Scope | Notes |
| --- | --- | --- |
| Identity self-check | `auth.test` call | No scope required — every bot token can call `auth.test` to confirm its own identity/team. |
| Channel lookup | `channels:read` (public), `groups:read` (private) | Needed to resolve a channel name/ref to an ID before posting. |
| Posting messages | `chat:write` | Core scope; also required for threaded replies (same scope, pass `thread_ts`). |
| Threaded replies | `chat:write` | No separate scope; thread targeting is a message parameter, not a scope. |
| Reactions | `reactions:write` | Add/remove emoji reactions. |
| Inbound direct messages | `im:history` (Events API subscription `message.im`) | Generated manifests configure the resolved HTTPS Request URL and subscribe to direct messages. |
| Inbound public-channel thread replies | `channels:history` (Events API subscription `message.channels`) | Receiver dispatches only replies in threads already owned by the routed agent. |
| Inbound private-channel thread replies | `groups:history` (Events API subscription `message.groups`) | Uses the same exact-thread ownership gate. |
| Inbound multi-person DM thread replies | `mpim:history` (Events API subscription `message.mpim`) | Uses the same exact-thread ownership gate. |
| Setup metadata discovery | `users:read` | Lets Paperclip resolve the installed App ID through `bots.info` after `auth.test` returns the bot ID. |
| Inbound mentions | `app_mentions:read` (Events API subscription `app_mention`) | An app mention establishes ownership of its Slack thread. Top-level channel messages without a mention remain ignored. |
| (Optional) join channels itself | `channels:join` | Only if the agent should self-invite rather than be invited by an operator/user. |

This is the **minimum** set for identity check, channel lookup, posting, reactions, inbound direct
messages, mentions, and follow-up replies in owned threads. Do not request broader scopes such as
`users:read.email` without a separate justification, per least-privilege.

Source: [OAuth scopes reference](https://api.slack.com/scopes) (per-scope descriptions);
[Reference: Slack apps manifest structure — `oauth_config.scopes.bot`](https://api.slack.com/reference/manifests#oauth_config).

## OAuth v2 install flow (for reference / future automation)

Even though the MVP relies on Slack's own manifest-driven "Install to Workspace" click-through
(no OAuth code written by us yet), any future in-house install flow must implement:

1. **State validation**: generate an unguessable `state` value per install attempt, store it
   server-side, and verify the callback's `state` matches before exchanging the code — CSRF
   protection for the redirect.
2. **HTTPS redirect URI matching**: the `redirect_uri` in the authorize request must exactly
   match one configured on the app; Slack enforces exact-match HTTPS redirect URLs.
3. **Code exchange**: `oauth.v2.access` with `client_id`, `client_secret`, `code`, and
   `redirect_uri` returns the bot token (`xoxb-...`), `authed_user`, `team` (id, name), and
   `enterprise` (if applicable) — response includes `bot_user_id` and `app_id`.
4. **Token rotation/revocation**: Slack supports OAuth token rotation (refresh-token based bot
   tokens) as an opt-in app setting, and `auth.revoke` to explicitly revoke a token (e.g., on
   uninstall or credential compromise).
5. **Workspace/team + install metadata**: persist `team.id`, `team.name`, `app_id`,
   `bot_user_id`, and install timestamp as shareable install metadata — none of this is secret;
   only the resulting bot token is.

Sources: [Installing with OAuth](https://api.slack.com/authentication/oauth-v2);
[Rotating and refreshing configuration tokens](https://api.slack.com/authentication/rotation)
(illustrates Slack's general rotation pattern, applied to config tokens above);
[`auth.revoke` method](https://api.slack.com/methods/auth.revoke).

## Shareable vs. secret data

| Shareable (safe in manifest JSON, docs, issue comments) | Secret (never in agent config, workspaces, tool output, issue comments, logs, or git) |
| --- | --- |
| Manifest JSON itself (`display_information`, `oauth_config.scopes`, `settings.event_subscriptions.request_url`, `settings.interactivity`) | Signing secret |
| App ID, bot user ID, team/workspace ID | Client secret |
| Requested/granted scope names | Bot token (`xoxb-...`), user token (`xoxp-...`) |
| Redirect URI values | App-level token (`xapp-...`) |
| Install timestamp, app name/description/icon | App configuration token + configuration refresh token |
| | OAuth bot/user **refresh tokens** — if `token_rotation_enabled: true` is used, these are bearer credentials that mint new access tokens and must be protected with the same rigor as the access token itself, not treated as install metadata |
| | OAuth `state` value (short-lived secret, not long-term credential material but must not be logged) |

## Current generated manifest template (HTTP Events API; no Socket Mode)

`eventsRequestUrl` is validated as HTTPS with no whitespace, query, fragment, or embedded
credentials, using only characters RFC 3986 permits. Because the value is embedded verbatim rather
than re-serialized, that envelope is enforced in two places — the `eventsRequestUrl` config-schema
`pattern` in `src/manifest.ts`, which gates persisted config, and `normalizeEventsRequestUrl` in
`src/providers/slack/app-manifest.ts`, which gates the manifest flow. A URL one accepts and the
other rejects strands an operator with config that saves cleanly and then fails provisioning, so
both import the same definition from `src/shared/events-request-url.ts`. Paired accept/reject cases
in `tests/manifest-config-schema.spec.ts` and `tests/providers/slack/app-manifest.spec.ts` pin that
agreement.

Sharing the pattern is necessary but was not sufficient. Each side originally ran a *second*,
*different* URL check alongside it — the schema applied Ajv's RFC 3986 `format: "uri"`, the runtime
applied WHATWG `new URL()` — and those two disagree in both directions. WHATWG normalizes where RFC
rejects (`https://host\events` becomes a slash, illegal characters and malformed escapes get
percent-encoded, non-ASCII hosts become punycode), while RFC's unbounded `port = *DIGIT` accepts
`:99999`, which WHATWG rejects. Measured against the shared-pattern-only build, 11 of 13 probe
cases still drifted, 9 of them failing open. Both extra checks were therefore removed: the pattern
is now the **complete** contract on both paths, so drift is structurally impossible rather than
patched case by case. **Do not add a second check to either side** — if the envelope needs to
change, change the pattern.

That removal is only safe because the pattern is strictly stricter than both validators it
replaced. `tests/shared/events-request-url.spec.ts` proves it in CI by sweeping every ASCII
codepoint across host, path, origin, port, and bracketed-literal positions and asserting that every
pattern-accepted value is *also* accepted by `format: "uri"` **and** by `new URL()`. If that test
fails, the pattern has become looser than one of them — fix the pattern, not the call sites.

That sweep was originally positional substitution only, and it missed a containment hole for a full
release: substituting one character into a fixed template can never produce a host whose *final
label* is numeric, which is exactly the shape the two validators disagree on (see below). When
extending the sweep, vary the shape of the input, not just one character inside a fixed one.

The envelope is matched against the **raw string** rather than against parsed `URL` properties,
because `URL` normalizes in precisely the places this check needs it to reject: it accepts embedded
credentials, percent-encodes interior whitespace instead of throwing, and reports `search`/`hash` as
empty for a trailing `?` or `#` while still keeping the delimiter in `href`. Each of those slipped
past an earlier property-inspection implementation. The pattern is an allowlist of RFC-legal
characters rather than a denylist, because every one of those bugs came from a denylist missing a
character; an allowlist fails closed instead.

### Host grammar

The host is three disjoint alternatives rather than one character class, because the two validators
disagree about hosts in both directions:

- **`reg-name`**, with the extra rule that the final label must begin with a letter. WHATWG re-reads
  the *entire* host as IPv4 whenever the final label parses as a number, and throws when that fails,
  so `https://a;.1` is a valid `reg-name` to RFC 3986 and a parse error to `new URL()`. No real DNS
  name has a numeric TLD, so the constraint costs nothing and closes the hole. A trailing root dot
  (`https://example.com.`) stays legal.
- **`IPv4address`**, spelled out as an explicit 0-255 dotted quad. Leading zeros and hex or octal
  shorthand are excluded: WHATWG accepts them, RFC 3986 does not.
- **`IP-literal`**, the bracketed RFC 3986 `IPv6address`. `URL.origin` keeps the brackets and colons
  for such a deployment, none of which are legal in a `reg-name`, so without this the plugin would
  derive a URL that fails its own envelope. Zone identifiers (RFC 6874 `[fe80::1%25eth0]`) and
  `IPvFuture` (`[v1.fe]`) are deliberately excluded — RFC 3986 permits both and WHATWG rejects both.

`buildSlackEventsRequestUrl` in `src/shared/webhook-endpoints.ts` runs its own output through
`matchesEventsRequestUrlEnvelope` and returns `null` if it fails. That is not a second validator in
the sense forbidden above — it is the *same* discriminator, applied by the producer, so the
derivation can never hand Settings a value the worker would refuse. The Settings gate only checks
that the derived URL is non-empty, so a non-conforming derivation would otherwise enable the
manifest button and fail inside the worker.

`src/providers/slack/app-manifest.ts` inserts the validated URL into the generated manifest. It is
no longer pinned to `/events`: Settings derives the host's own company-scoped webhook route
(`.../webhooks/slack-events`) whenever the origin is HTTPS, and the operator field is an override
used mainly for the local dev tunnel.

```yaml
_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: "Paperclip Agent - {{agentLabel}}"
  description: "Paperclip agent identity for {{agentLabel}}"
  background_color: "#4A154B"
features:
  bot_user:
    display_name: "Paperclip Agent - {{agentLabel}}"
    always_online: false
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  agent_view:
    agent_description: "Paperclip agent identity for {{agentLabel}}"
oauth_config:
  scopes:
    bot:
      - assistant:write
      - app_mentions:read
      - chat:write
      - channels:history
      - channels:read
      - groups:history
      - groups:read
      - im:history
      - mpim:history
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    request_url: "{{eventsRequestUrl}}"
    bot_events:
      - app_home_opened
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Notes:

- `token_rotation_enabled: false`. Setting this to `true` is an irreversible, one-way app setting
  that makes newly issued bot access tokens expire after 12 hours and requires the app to
  implement refresh-token persistence and renewal via `oauth.v2.access`. The MVP explicitly has
  no refresh-token implementation (no storage, no renewal scheduler, no client-credential
  handling); enabling rotation against this template would produce an app whose bot token stops
  working after 12 hours with no code path to renew it. Keep rotation off until the refresh
  lifecycle (client credentials, expiry tracking, atomic dual-token renewal) is designed and
  tested, then flip this flag as part of that follow-up work — not before.
- `socket_mode_enabled: false` and no `app_level_token` scopes keeps the app Marketplace-eligible
  and avoids a second credential class.
- `{{agentLabel}}` and `{{eventsRequestUrl}}` represent values supplied to the existing manifest
  builder in `src/providers/slack/app-manifest.ts`. App names are capped at 35 characters and bot
  display names at 80 characters to match Slack's manifest limits.

Source: [Manifest structure reference](https://api.slack.com/reference/manifests) (all fields
above, including `socket_mode_enabled` and `token_rotation_enabled`).

## Rejected alternatives

- **Single shared Slack app/bot for all agents.** Rejected: bot identity is per-app, so this
  collapses all agents into one visible Slack identity — fails the "distinct visible agent
  identities" requirement outright.
- **Socket Mode as the default transport.** Rejected as default: needs an extra app-level-token
  credential class, is unsupported for Marketplace distribution, and adds reconnect/ack handling
  complexity with no offsetting benefit: HTTP Events API is the simpler default once its
  ingress prerequisite is built, and Socket Mode's dial-out model isn't needed just to avoid
  building that ingress (see the inbound-routing gap noted above).
- **App Manifest API automation as the default per-agent install path.** Rejected as default:
  requires holding a 12-hour configuration token plus a rotating refresh token — an extra secret
  class the manifest-deep-link path avoids entirely. Kept as an optional, clearly-labeled
  operator path for bulk provisioning.
- **Operator pastes their personal Slack user token into agent config for provisioning.**
  Rejected outright: violates the "no operator credential in agent config" constraint and this
  repo's redaction/credential-handling model; the manifest deep link and OAuth install flow never
  require this.

## Current implementation and remaining follow-up

- Setup order is deliberate: generate and install the Slack app first; create company secrets for
  the bot token and signing secret; save team, app, and bot IDs plus both secret UUIDs; then return
  to Slack and verify the Request URL. Verification may fail before the signing-secret reference
  is saved because the receiver cannot authenticate Slack's challenge yet.
- `save-slack-install-metadata` stores shareable install metadata in identity state and writes both
  company-scoped typed secret refs through `ctx.config.patchSecretRefs` under
  `identities.<agentId>.slack.credentials`.
- `scripts/slack-events-adapter.mjs` is the temporary local testing bridge. It listens only on
  `127.0.0.1:3110`, accepts `POST /events`, and forwards the unchanged body and Slack headers to
  `http://127.0.0.1:3100/api/companies/<companyId>/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events`.
  `PAPERCLIP_COMPANY_ID` is required and must be a canonical UUID. A public HTTPS tunnel or proxy
  can target the adapter during tests and can be disabled afterward.
- Socket Mode, OAuth callback automation, and token rotation remain deferred.

## DRO-1157 feasibility decision: auto-provisioning secrets is blocked on a host-core capability gap

**Status: infeasible in this plugin today; blocked on Paperclip host-core, not this repo.**

DRO-1157 asked for the plugin to *create* the two company-scoped Slack secrets (bot token,
signing secret) automatically after install and bind their new IDs into the open identity dialog,
removing the manual "create a secret, paste its UUID" operator step described above.

Checked against the actual plugin SDK surface (`@paperclipai/plugin-sdk` `PluginConfigClient` /
`PluginSecretsClient`, mirrored locally in `src/plugin-sdk-secure-config.d.ts`) and the host's
capability table (`plugin-capability-validator`):

- `ctx.config.patchSecretRefs` — **binds** an existing `{type: "secret_ref", secretId, version?}`
  reference into plugin config. It does not create a secret or accept a raw value; it requires
  `secrets.bind-ref` and the secret must already exist in the host secret store.
- `ctx.secrets.resolve` — **reads** the current value of an existing secret reference at call
  time. Requires `secrets.read-ref`. No write path.
- There is no `secrets.create`/`secrets.write-value` (or equivalent) capability or client method
  anywhere in the SDK types or the host capability table. A plugin has no supported way to mint a
  new company-scoped secret record from a value it holds in memory (e.g., a freshly received
  `oauth.v2.access` bot token) — only to bind/read secrets a human already created through the
  host's own secret-management UI.

(`secrets.bind-ref` is supported by the running host but absent from the published
`PLUGIN_CAPABILITIES` union in `@paperclipai/shared` as of this writing — this repo's manifest
declares it with an explicit "host supports this ahead of the published SDK type union" cast; see
`src/manifest.ts:197`. `secrets.read-ref` is in the published union and needs no cast.)

This matches the "feasibility boundary" called out in the issue body: the SDK "resolves existing
secrets but does not appear to expose a host-supported company-secret write capability." That is
confirmed, not just suspected. Building secret creation inside this plugin (writing directly to
plugin state, a config field, or a sidecar file, and pointing an identity ref at it) is explicitly
out of bounds per this repo's threat model and the issue's own constraints ("do not emulate secret
storage in plugin state, config, sidecars, browser storage, or agent-visible tools").

**Disposition:** the manual two-step ("operator creates the secret in company secrets UI, pastes
its UUID into the identity dialog") described earlier in this section remains the correct and only
compliant flow until Paperclip host-core ships a `secrets.create-value` (or similarly scoped)
plugin capability that: accepts a raw value server-side only, returns an opaque secret ID, enforces
company/agent scoping and idempotent-on-retry semantics, and never echoes the value back to the
plugin or the browser. That capability does not exist in `@paperclipai/plugin-sdk` as of this
writing and must be designed, reviewed, and shipped by whoever owns Paperclip host-core (outside
this repository) before any of DRO-1157's OAuth-callback/manifest-automation/UX work can proceed.
Filed as a host-core capability request: [DRO-1175](https://paperclip.roshangautam.com/DRO/issues/DRO-1175).

**Outcome (2026-07-29): declined, won't-do.** Roshan answered option C ("don't") on the DRO-1175
interaction, and both DRO-1175 and this stretch issue (DRO-1157) were closed won't-do the same day.
The manual two-step flow above is the standing, permanent state — not an interim measure pending a
capability that is now confirmed not to be coming. This section and the linked design spec
([host-core-secrets-create-value-design](/domain/host-core-secrets-create-value-design)) are
retained as a reference artifact only, in case the question is reopened in the future.

## Sources

- [App manifests overview](https://api.slack.com/reference/manifests)
- [App Manifest APIs / configuration tokens](https://api.slack.com/reference/manifests#config-tokens)
- [Using Socket Mode](https://api.slack.com/apis/socket-mode)
- [The Events API](https://api.slack.com/apis/events-api)
- [Verifying requests from Slack](https://api.slack.com/authentication/verifying-requests-from-slack)
- [OAuth scopes reference](https://api.slack.com/scopes)
- [Installing with OAuth (OAuth v2)](https://api.slack.com/authentication/oauth-v2)
- [Rotating and refreshing tokens](https://api.slack.com/authentication/rotation)
- [`auth.revoke` method](https://api.slack.com/methods/auth.revoke)
- [Bot users](https://api.slack.com/bot-users)
- [Token types](https://api.slack.com/authentication/token-types)
