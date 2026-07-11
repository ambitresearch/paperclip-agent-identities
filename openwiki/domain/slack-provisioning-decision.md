# Slack app manifests and per-agent provisioning — decision record

Status: **decided (research)** — no Slack provider code exists yet. This document is the
authoritative input for a future `feat(providers): add Slack identity provider` task; it does not
itself add a provider.

## Decision

- **One Slack app + one bot user per Paperclip agent.** Slack bot identity attribution is
  per-app: a bot token authenticates as *that app's* bot user, so distinct visible names/avatars
  in Slack require distinct apps, not distinct tokens off one app. This is the load-bearing fact
  that shapes everything below.
  Source: [Enabling interactions with bots](https://api.slack.com/bot-users) (bot users belong to
  one app each); [Differences between bot and user tokens](https://api.slack.com/authentication/token-types#bot).
- **MVP install path: manifest deep link, operator-driven, manual per agent.** For each agent,
  the operator opens `https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded manifest>`,
  reviews the manifest Slack renders, picks the target workspace, and clicks
  **Create**. Slack then walks the operator through installing the app to the workspace, which
  produces the bot token (and, per the canonical manifest, a signing secret). This install
  sequence itself requires no Slack credential of any kind inside Paperclip's config, workspace,
  or logs — only a URL our plugin generates. The resulting bot token and signing secret are still
  mandatory downstream artifacts: the operator must copy them into a Paperclip company secret and
  record only that secret's UUID in the credential sidecar (see "Downstream assumptions" and the
  shareable-vs-secret table below) before any Slack tool can resolve credentials.
  Source: [App manifests overview](https://api.slack.com/reference/manifests) (documents the
  `manifest_json` query-string param on `api.slack.com/apps?new_app=1`).
- **Event transport: HTTP Events API (Request URL), not Socket Mode.** Rejected Socket Mode for
  the default path — see rationale below. Socket Mode remains an optional advanced mode for
  operators who cannot expose a public HTTPS endpoint.
- **App Manifest APIs (`apps.manifest.*`) are an optional operator-only automation path**, not
  part of the default agent-facing flow, because they require a rotating, short-lived
  configuration token that itself needs secure storage and periodic refresh. Using them at all
  is a product decision to trade a small amount of operator convenience for holding another
  credential; the default path (manifest deep link) needs none.

## Why not Socket Mode by default

| Concern | HTTP Events API | Socket Mode |
| --- | --- | --- |
| Transport | Slack POSTs events to a public HTTPS Request URL | App opens an outbound WebSocket via `apps.connections.open` |
| Credential needed | Signing secret (verify `X-Slack-Signature` / `X-Slack-Request-Timestamp`) | App-level token (`xapp-...`, `connections:write` scope); events are authenticated via that token over the WebSocket, not HTTP request-signature verification, so the signing secret is not itself a Socket Mode transport credential |
| Marketplace / distribution | Supported for public distribution | **Not supported for Slack Marketplace apps** |
| Infra requirement | Needs a reachable HTTPS endpoint | No public endpoint needed; app dials out |
| Reconnect/ack model | Standard HTTP 200 ack within 3s; retries on non-2xx/timeout | Must ack each message over the socket and handle `disconnect`/reconnect frames, hello, and periodic re-opens |

Agent identities run behind a Paperclip-hosted worker, but that worker does not currently expose
any public inbound HTTP route or webhook: today's manifest only declares `http.outbound`, the
provider contract exposes tools/actions with no inbound-route hook, and the GitHub App flow
returns through the settings UI without configuring a webhook
(`openwiki/domain/agent-identities.md:151-175`). A public HTTPS Request URL for Slack Events API
ingress is therefore an **unimplemented prerequisite**, not an existing capability Slack can
mirror — it requires new inbound-routing infrastructure in the plugin/worker contract before any
Events API subscription can be added. That infrastructure gap does not change the transport
*decision* below (HTTP Events API over Socket Mode once ingress exists), but it means Events API
subscriptions (including `app_mention`) are out of MVP scope until the prerequisite ships (see
§10/"Inbound events" scoping in the follow-on design record). Socket Mode is documented here as a
fallback for operators in constrained network environments, gated as an explicit opt-in, and does
not depend on this missing inbound-routing prerequisite since it dials out rather than receiving
inbound HTTP.

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
to script bulk app creation for many agents at once. It must live in an operator-only credential
store analogous to the existing GitHub App-manifest bootstrap flow (private sidecar, never agent
config), never touched by agent-facing tools. The default per-agent flow (manifest deep link)
needs none of this and is preferred for that reason alone.

Source: [App Manifest APIs / Configuration tokens](https://api.slack.com/reference/manifests#config-tokens).

## Minimum bot scopes

| Capability | Scope | Notes |
| --- | --- | --- |
| Identity self-check | `auth.test` call | No scope required — every bot token can call `auth.test` to confirm its own identity/team. |
| Channel lookup | `channels:read` (public), `groups:read` (private) | Needed to resolve a channel name/ref to an ID before posting. |
| Posting messages | `chat:write` | Core scope; also required for threaded replies (same scope, pass `thread_ts`). |
| Threaded replies | `chat:write` | No separate scope; thread targeting is a message parameter, not a scope. |
| Reactions | `reactions:write` | Add/remove emoji reactions. |
| Inbound mentions | `app_mentions:read` (Events API subscription `app_mention`) | Requires the bot to already be a member of the conversation to receive it, or — for the specific inciting mention only — the user's mention to trigger an invitation flow the bot must accept; an app that is not a member and does not accept the invite receives no event. This is not unconditional coverage. |
| (Optional) join channels itself | `channels:join` | Only if the agent should self-invite rather than be invited by an operator/user. |

This is the **minimum** set for identity check → find channel → post → thread-reply → react →
receive mentions. Do not request broader scopes (e.g. `channels:history`, `users:read.email`)
without a separate justification, per least-privilege.

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

## Canonical manifest template (MVP: HTTP Events API, no Socket Mode)

```yaml
_metadata:
  major_version: 1
  minor_version: 1
display_information:
  name: "Paperclip Agent — {{agentLabel}}"
  description: "Paperclip agent identity for {{agentLabel}}"
  background_color: "#4A154B"
oauth_config:
  redirect_urls:
    - "https://{{workerHost}}/slack/oauth/callback"
  scopes:
    bot:
      - chat:write
      - channels:read
      - groups:read
      - reactions:write
      - app_mentions:read
settings:
  event_subscriptions:
    request_url: "https://{{workerHost}}/slack/events"
    bot_events:
      - app_mention
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
- `{{agentLabel}}`, `{{workerHost}}` are template placeholders filled by our composition layer at
  manifest-generation time, analogous to how the existing GitHub App-manifest flow parameterizes
  its manifest today (`src/credential-sidecar.ts` / `src/ui/SettingsPage.tsx` GitHub App setup
  action) — a Slack provider would add an equivalent manifest-building helper under
  `src/providers/slack/`, composed once through `src/providers/index.ts` per the "no
  provider-specific branches in `worker.ts`/`manifest.ts`" constraint.

Source: [Manifest structure reference](https://api.slack.com/reference/manifests) (all fields
above, including `socket_mode_enabled` and `token_rotation_enabled`).

## Rejected alternatives

- **Single shared Slack app/bot for all agents.** Rejected: bot identity is per-app, so this
  collapses all agents into one visible Slack identity — fails the "distinct visible agent
  identities" requirement outright.
- **Socket Mode as the default transport.** Rejected as default: needs an extra app-level-token
  credential class, is unsupported for Marketplace distribution, and adds reconnect/ack handling
  complexity with no benefit here since the worker can already host an HTTPS endpoint.
- **App Manifest API automation as the default per-agent install path.** Rejected as default:
  requires holding a 12-hour configuration token plus a rotating refresh token — an extra secret
  class the manifest-deep-link path avoids entirely. Kept as an optional, clearly-labeled
  operator path for bulk provisioning.
- **Operator pastes their personal Slack user token into agent config for provisioning.**
  Rejected outright: violates the "no operator credential in agent config" constraint and this
  repo's redaction/credential-handling model; the manifest deep link and OAuth install flow never
  require this.

## Downstream assumptions requiring follow-up implementation work

- A Slack provider module under `src/providers/slack/` (manifest builder, OAuth callback handler,
  event Request URL handler, credential sidecar entry) composed through
  `src/providers/index.ts`, mirroring the existing GitHub provider composition-root pattern
  described in `openwiki/domain/agent-identities.md` (there is no separate provider-adapter
  workflow document; this is the authoritative reference for the provider contract and
  composition pattern).
- A settings-UI step to generate the per-agent manifest deep link (reusing the existing GitHub
  App-manifest-flow UI pattern in `src/ui/SettingsPage.tsx`).
- Storage of Slack install metadata (team ID, app ID, bot user ID) in the public identity config
  (mirrors `github.username` today), with the bot token/signing secret/refresh material held only
  in the local credential sidecar, never in `BotIdentityConfig`.

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
