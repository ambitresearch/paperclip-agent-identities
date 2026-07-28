# Slack provider MVP — contract, product boundary, threat model

Status: **partially implemented**. The identity config, company-scoped credential refs, Slack tools,
HTTP Events API receiver, and manifest-assisted setup flow exist and are covered by tests. Generated
manifests require an HTTPS URL with no query, fragment, or embedded credentials,
include `settings.event_subscriptions.request_url`, and subscribe to direct messages,
app mentions, and thread replies in public channels, private channels, and
multi-person DMs. Settings derives that URL from this deployment's own webhook
route; the operator field is an override for local development (see §5).
Socket Mode, OAuth callback automation, and token rotation remain deferred.

## 1. Identity shape

Follows the existing discriminated-union convention in `AgentIdentityConfig`
(`/src/core/identity-config.ts`) — a new variant, not new top-level fields:

```ts
type SlackAgentIdentityConfig = {
  provider: "slack";
  id: string;        // `${agentId}:slack`
  agentId: string;
  label: string;      // "Agent Name [Company Name]", same convention as GitHub
  slack: {
    teamId: string;       // Slack workspace/team ID — shareable, not secret
    appId: string;        // Slack app ID — shareable
    botUserId: string;    // resulting bot user ID — shareable
    eventsRequestUrl?: string; // generated manifest Events API URL
    defaultChannel?: string; // optional channel name/ID the agent posts to by default
  };
};
```

No Slack credential value appears in this type. Public identity state contains only shareable
metadata; the bot token and signing secret are represented separately as company-scoped typed
secret refs.

## 2. Install metadata vs. credential references

Separates public identity metadata from host-managed credential references:

- **Public identity config** (`identities[agentId:slack]` in `bot-identity-config`, v5 settings
  state): `teamId`, `appId`, `botUserId`, `eventsRequestUrl`, `defaultChannel` — all shareable per the decision
  record's shareable/secret table.
- **Company-scoped host config** (`identities.<agentId>.slack.credentials`): typed `secret_ref`
  values for both required Slack credentials and no public scalar metadata.

  ```json
  {
    "identities": {
      "<agent-id>": {
        "slack": {
          "credentials": {
            "botToken": {
              "type": "secret_ref",
              "secretId": "<paperclip-secret-uuid>",
              "version": "latest"
            },
            "signingSecret": {
              "type": "secret_ref",
              "secretId": "<paperclip-secret-uuid>",
              "version": "latest"
            }
          }
        }
      }
    }
  }
  ```

  `save-slack-install-metadata` validates both secret IDs as UUIDs before mutation and persists only
  this credential subtree with `ctx.config.patchSecretRefs`. `resolveSlackBotToken` and
  `resolveSlackSigningSecret` read the company config snapshot and resolve only the required ref
  through `ctx.secrets.resolve`. There is no plaintext or token-file fallback for Slack.
  Existing static GitHub fields stay at `identities.<agentId>` and can coexist with this Slack
  subtree. Public fields retained in full nested or flat legacy Slack host records are ignored;
  only their existing credential paths remain readable and writable. Released
  `v0.1.7`/`v0.1.8` local-sidecar entries are separately recoverable through the explicit
  company-authorized rebind action; they are never used as a runtime token fallback.

  **Rotation decision: MVP disables Slack token rotation (`token_rotation_enabled: false`).**
  Tracking a single extra refresh-token reference is not a complete rotation contract: rotated bot
  tokens expire after 12 hours, and refreshing one requires `oauth.v2.access` with the rotating
  refresh token *and* the app's `client_id`/`client_secret`, followed by durable atomic replacement
  of both the access and refresh tokens on every renewal. None of the client-credential storage,
  expiry metadata, or renewal semantics exist in this config shape or in the current plugin SDK
  (no supported secret-write path — see §6), so a partial rotation contract would leave tools
  eventually calling with an expired token. MVP therefore stores a single long-lived
  Paperclip-secret-backed bot token and leaves rotation off; a future task must land the full
  refresh lifecycle (client credentials, expiry tracking, atomic dual-token renewal) as one unit
  before enabling rotation, not as a bolt-on refresh-token field.

## 3. Resource references

`ResourceReference` today is `{ kind: string }`. A Slack `SlackChannelRef` follows the same
narrowing pattern as `GitHubRepoRef`:

```ts
interface SlackChannelRef extends ResourceReference {
  kind: "slack-channel";
  channel: string; // resolved channel ID, never a raw operator-supplied token
  teamId: string;
}
```

`resolveResourceRef` (the async, pre-credential step in `ProviderToolSpec`) runs **before**
`provider.resolveCredential`, and its input carries no token. Slack's channel lookup
(`conversations.list`/`conversations.info`) is an authenticated API call, so it cannot run at this
pipeline stage. `resolveResourceRef` therefore stays credential-free: it accepts and syntactically
validates a caller-supplied channel **ID** (not a name), rejecting malformed/empty/wildcard values.
Translating a human-readable channel *name* to an ID requires a token and is the deferred
`slack_bot_lookup_channel` tool's job (§4). Callers currently need to supply a channel ID directly.
A channel ID that doesn't validate
syntactically, or one outside an allow-list (if one is configured), is denied at this step; Slack's
own membership/ACL check happens later, in the credentialed `perform` step, and is the actual
authorization boundary (see §9, "Confused-deputy posting" mitigation).

## 4. Tools (mapped 1:1 to minimum bot scopes from the decision record)

| Tool | `requiresCredential` | Scope | Resource ref |
| --- | --- | --- | --- |
| `slack_bot_whoami` | `false` (echoes configured identity fields; no `auth.test` call) | none | none |
| `slack_bot_post_message` | `true` | `chat:write` (also handles threaded replies through `threadTs`) | `SlackChannelRef` |
| `slack_bot_add_reaction` | `true` | `reactions:write` | `SlackChannelRef` |
| `slack_bot_remove_reaction` | `true` | `reactions:write` | `SlackChannelRef` |
| `slack_bot_lookup_channel` (deferred) | `true` | `channels:read`, `groups:read` | none (this tool produces a ref) |

No `slack-join-channel` tool in MVP — `channels:join` is listed as optional/deferred in the
decision record; omit until a concrete need surfaces (least-privilege: don't request or wire a
scope with no consuming tool).

`slack-whoami` shipped credential-free, matching GitHub's local `github-whoami` rather than
diverging from it as an earlier revision of this doc specified: `requiresCredential: false`, no
`auth.test` call, no bot-token resolution. `perform` only echoes the already-validated,
configured `SlackAgentIdentity` fields (`label`, `teamId`, `appId`, `botUserId`,
`hasDefaultChannel`); a stale or misconfigured identity is not caught by this tool — only the
credentialed tools' `auth.test` resolution step catches that.

## 5. Manifest fragments

`IdentityProvider.manifestTools` is flattened directly into the composed Paperclip plugin
manifest's tool declarations. It is not a place to attach Slack's app-manifest template.
`manifestTools` declares the registered Slack tools' Paperclip-facing metadata, including names,
descriptions, and parameter schemas, exactly like GitHub's `manifest-tools.ts`. Slack app-manifest
JSON generation lives in the contributed `create-slack-app-manifest` action instead, matching where
GitHub's App manifest generation lives (`contributeGitHubAppManifestActions`).

The generated manifest accepts an HTTPS URL with no query, fragment, or embedded
credentials, inserts it at `settings.event_subscriptions.request_url`, requests the direct-message and
channel history scopes, and subscribes to `message.im`, `app_mention`, `message.channels`,
`message.groups`, and `message.mpim`. Top-level messages containing Slack's `<!channel>`,
`<!here>`, or `<!everyone>` broadcast tokens start an agent-owned reply thread. Other ordinary
top-level channel messages are acknowledged and ignored. A plain thread reply is dispatched only
when that agent already owns the exact thread through a session mapping created by an earlier app
mention or broadcast.
`settings.interactivity.is_enabled: false`, `socket_mode_enabled: false`, and
`token_rotation_enabled: false` remain explicit.

### Events Request URL resolution

The URL is not pinned to any particular path. Slack must reach the host's
company-scoped webhook route for this plugin's `slack-events` endpoint, so the
production answer is fully derivable and Settings derives it:
`<origin>/api/companies/<companyId>/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events`.
`src/shared/webhook-endpoints.ts` is the single dependency-free source of that
route template, shared by the worker webhook (`provider-webhook.ts`) and the
client Settings bundle. It returns `null` when the origin is not HTTPS, since
Slack only delivers over HTTPS and there is then no derivable answer.

The Settings field is therefore an **optional override**, resolved at call time
as `config.slackEventsRequestUrl.trim() || derivedUrl || ""`, never prefilled
into state. Prefill was rejected: an effect that writes the field fights the
operator clearing it, and flow reconciliation treats a non-empty field as
explicit operator intent, which would reject a restored tunnel flow. Resolving at
call time leaves reconciliation untouched — a blank field already means "adopt
the restored flow's URL". The create handler writes the resolved URL back into
the field afterwards so the `credentialComplete` equality checks in
`settings-adapter-ui.tsx` and `settings-adapter.ts` can match.

The field is required only when no URL can be derived, which in practice means
local development over plain HTTP. `/events` is a convention of the dev loopback
adapter alone (§10), not of this plugin.

## 6. Actions (`contributeActions`)

Mirrors `contributeGitHubAppManifestActions`: a `create-slack-app-manifest` worker action that
builds the per-agent manifest JSON and returns the plain `https://api.slack.com/apps?new_app=1`
"create app" URL alongside it (Slack has no documented query parameter to prefill a manifest, so
this is not a prefilled deep link; see §7), and a `save-slack-install-metadata` action the settings
UI calls once the operator finishes Slack's own click-through install. Manifest creation also requires the
Events Request URL, which Settings derives when it can.  The save action requires the shareable IDs (`teamId`/`appId`/`botUserId`) and
both `botTokenSecretId` and `signingSecretId`. There is
no supported host/plugin API for a worker action to create a Paperclip secret from a raw token
(`ctx.secrets` exposes only `resolve`; `secrets.bind-ref` can attach only existing secret refs — see
§7), so the action cannot mint that secret itself. The explicit sequence is:

1. Operator accepts the derived Events Request URL (or supplies an override), generates the manifest,
   pastes it into Slack, creates the app, and installs it to the workspace. Slack may initially show
   the Request URL as unverified.
2. Operator copies the Bot User OAuth Token (`xoxb-...`) and signing secret from Slack, creates a
   separate Paperclip company secret for each value, and copies both resulting UUIDs.
3. Operator pastes `teamId`, `appId`, `botUserId`, both secret UUIDs, and any default channel ID into
   the settings form. `save-slack-install-metadata` persists the public identity and writes both
   typed refs through `ctx.config.patchSecretRefs`. It never receives either raw secret.
4. Operator returns to Slack, retries Request URL verification, and saves the manifest changes.

(no OAuth code exchange in MVP; Slack's copy/paste manifest flow produces the bot token via its
own UI, not a callback we handle). This is a deliberately smaller flow than GitHub's manifest
conversion, because there is no documented Slack mechanism to prefill a manifest via URL and so no
GitHub-style "exchange code for PEM" step either. The operator supplies one public URL, relays back
shareable IDs, and selects two secret references, never the secret values.

## 7. UI contributions

Adds a Slack section to `/src/ui/SettingsPage.tsx` alongside GitHub, following the same
add/edit/delete-one-identity-per-provider-per-agent pattern, prefilling `label` from agent
display name + company (same convention). No propagated environment variables in MVP. Unlike
GitHub App credentials, which the worker pushes into the agent's adapter environment
(`GITHUB_APP_ID` etc.), Slack bot tokens should NOT be propagated as adapter env vars, because
Slack tool calls go through the provider's `resolveCredential` and company-scoped host-config path,
not an env-var-injected client the agent process constructs itself. This avoids adding a second path by
which a Slack token could land in an agent's environment/logs.

## 8. One-app-per-agent naming, workspace constraints, channel authorization, install ownership

- **Naming**: `Paperclip Agent - {{agentLabel}}` per the canonical manifest template, matching the
  decision record's requirement that distinct visible Slack identities need distinct apps (bot
  identity is per-app, not per-token).
- **Workspace constraint**: each agent's Slack app installs into exactly one workspace (`teamId`),
  chosen by the operator during the manifest copy/paste flow. Multi-workspace agents are out of MVP
  scope and would need one identity config entry per `(agentId, teamId)` pair.
- **Channel authorization**: MVP does not implement its own authorization layer (same posture as
  GitHub — "Provider authorization" section of `agent-identities.md`: this repo maps identities to
  credentials and lets the provider's own permission model do the enforcing). For Slack that means
  channel-level authorization is Slack's own: the bot can only post/react/read in channels it has
  been invited to (or that are public and it has `channels:read` for lookup only, not necessarily
  post rights without membership). No allow-list config is required for MVP; document that an
  operator-configured channel allow-list is a possible deferred hardening step.
- **Install ownership**: the operator who opens the "create app" link, pastes in the manifest, and
  completes the Slack "Install to Workspace" click-through owns the resulting app at the
  Slack-workspace-admin level. Paperclip stores only typed references to the bot-token and
  signing-secret company secrets plus shareable IDs; it never becomes a Slack workspace admin.

## 9. Threat model

| Threat | Mitigation |
| --- | --- |
| **Credential disclosure** (bot token / signing secret / refresh token leaked via config, logs, git, tool output) | Both Slack credentials remain Paperclip company secrets referenced by typed host-config refs. Resolvers call `ctx.secrets.resolve` just in time, and tools never return a secret. The mandatory pipeline order keeps credential values in memory for the shortest practical window. |
| **Confused-deputy posting** (agent A's tool call posts using agent B's Slack identity) | `resolveAgentIdentity()` keys strictly off `runContext.agentId` (same as GitHub) — there is no cross-agent identity parameter a tool call can supply. Because Slack identity is 1 app/bot-user per agent, there is no shared-token surface for a mixup to exploit (unlike a hypothetical shared workspace app). |
| **Forged OAuth callbacks** | MVP does not implement an OAuth callback. It uses manifest copy/paste plus operator entry of IDs, so this threat class is deferred until an in-house OAuth install flow is built. At that point the decision record's OAuth section (state validation and exact redirect-URI matching) becomes the mandatory implementation baseline. |
| **Replayed events** (inbound Events API POSTs replayed by an attacker) | Implemented (DRO-1005, see §10): `src/providers/slack/ingress/signature.ts` verifies `X-Slack-Signature`/`X-Slack-Request-Timestamp` per the decision record's HTTP-vs-Socket-Mode section, AND rejects requests with a timestamp outside a 5-minute window to bound replay. |
| **Cross-workspace IDs** (a `teamId`/`channel` ref from workspace X accidentally used against workspace Y's token) | `SlackChannelRef.teamId` is carried alongside `channel` through `resolveResourceRef`; the tool must assert `identity.slack.teamId === ref.teamId` before calling `perform`, the same "expectedRepository mismatch guard" pattern GitHub's push tool already uses for cross-repo mixups. |
| **Revoked tokens** (bot token revoked/uninstalled mid-operation) | `resolveCredential` calls fail closed (matching `fail closed with stable error on credential resolution failure`, already implemented for GitHub in `f8baa63`) — a Slack API 401/`invalid_auth` response surfaces as a tool error, not a silent no-op or retry-with-stale-token. |
| **Logging** (accidental token/signing-secret leakage into structured logs or error messages) | Errors from Slack API calls must be sanitized the same way GitHub App token errors already avoid returning secret values (see "GitHub App token minting" section of `agent-identities.md`) — never log full request/response bodies for Slack `oauth.v2.access`, `apps.manifest.*`, or Events API signature-verification failures. |
| **Transport diagnostic misattributed as agent content** (DRO-1162: an ACPX/adapter transport warning, e.g. "Model metadata not found, defaulting to fallback metadata", streamed to Slack as if the agent authored it) | `SlackSessionReplyAccumulator` (`src/providers/slack/ingress/session-reply.ts`) drops the ambiguous old `acpx.text_delta` + `channel: "output"` + `tag: "agent_message_chunk"` shape entirely: it is never accumulated, streamed, or delivered at finish. This is a **plugin-side fail-closed mitigation only** — the shape carries no provenance/kind discriminator today, so a diagnostic and genuine prose remain structurally indistinguishable; the primary fix is the ACPX/core event-contract change tracked in `DRO-1183`; `paperclipai/paperclip#1465` currently covers only the terminal surface, not this downstream classification. Filtering here is intentionally based on event type/channel/tag, never text-pattern/model-name matching. Confirmed final records and non-JSON adapter fallback still preserve legitimate answers, including prose that discusses or quotes a warning. Lifecycle JSONL, `acpx.status`/`acpx.error`, tool-call records, reasoning/thought-channel deltas, and raw stderr never reach Slack reply content. |

## 10. Inbound events — HTTP receiver shipped (DRO-1005)

The inbound HTTP Events API receiver and generated Request URL subscription are implemented. The
manifest subscribes to `message.im`, `app_mention`, `message.channels`, `message.groups`, and
`message.mpim`; Socket Mode remains deferred and operator-opt-in per the decision record.

This is intentionally the HTTP slice selected by
[`slack-provisioning-decision.md`](./slack-provisioning-decision.md), not an implementation of
both Slack transports. The Socket Mode acceptance bullet that appeared on linked GitHub issue
#62 (operator-side app tokens, WebSocket envelope acknowledgements, and refresh/disconnect
handling) is broader than that decision and remains separate follow-up scope. PR #81 must not be
used as evidence that those Socket Mode behaviors shipped.

Implementation (`src/providers/slack/ingress/`):

- `signature.ts` — verifies `X-Slack-Signature` (HMAC-SHA256, constant-time compare) and rejects
  requests whose `X-Slack-Request-Timestamp` falls outside a 5-minute window, before the body is
  parsed or trusted, per the §9 replay mitigation.
- `routing.ts` — routes an inbound event to exactly one agent keyed on `(api_app_id, team_id)`; no
  match or more than one match both fail closed (no best-effort fan-out). For an
  `event_callback`, `authorizations` must be a non-empty list containing at least one installation
  whose `team_id` equals the outer `team_id`. That list is visibility evidence only: it never
  overrides the outer app/team route or fans a delivery out. Enterprise-only entries without a
  `team_id` are rejected because the MVP identity model is one workspace installation per agent.
- `conversation-session.ts` — owns the version-2 durable per-conversation record: reusable session
  mapping, FIFO pending turns, active/accepted/uncertain phase, and completed hashes. It bounds the
  queue at 32 active/pending turns and the total claim ledger at 1,024 hashes. Pending/active hashes
  do not expire; completed hashes remain for 24 hours measured from completion. The old independent
  10-minute dedup ledger is removed, so a duplicate cannot restart a run after minute 10 while that
  run is still active. A state write/read-back confirms that a newly queued hash survived; the SDK
  still has no cross-process CAS, so multi-worker atomic exactly-once claiming remains a host gap.
  On first contact with a version-1 accepted conversation record, the queue imports that agent's
  bounded released ledger and holds its hashes without expiry until the old run retires; they then
  become 24-hour completed claims. This prevents an in-flight pre-upgrade run from being replayed
  after minute 10. Because the released ledger was per-agent rather than per-conversation, all of its
  bounded hashes are conservatively retained on that legacy conversation during migration rather
  than risking a replay; new version-2 records do not consult the old ledger. If an old accepted run
  has no recoverable ledger, the first delivery is conservatively claimed as that uncertain run and
  not sent; its kick retires the old lease instead of guessing that a resend is safe. A pre-upgrade accepted callback cannot be rebound after a
  worker reload, so its durable lease is intentionally allowed to expire before retirement. A v1
  idle session converts the old bounded ledger directly to 24-hour completed claims.
- `webhook-handler.ts` — the pure pipeline composing the above, plus the `url_verification`
  handshake. It rejects bodies larger than 1 MiB before identity/secret resolution, applies a
  process-wide unauthenticated ingress limit, extracts bounded team/app fields as untrusted routing
  hints, and resolves only the exactly routed identity's signing secret for a normal callback.
  Deliveries without usable hints, including `url_verification`, use the bounded parallel fallback.
  An `event_callback` must contain a non-array event object with a nonblank `event.type`.
- `provider-webhook.ts` wires the pipeline to `PluginContext`. Webhook scope reads one company config
  snapshot, resolves only the routed signing secret, persists the bounded turn, awaits
  `ctx.events.emit("slack-turn-drain", companyId, payload)`, and returns 200. It never calls
  `ctx.agents.sessions.sendMessage` or waits for a previous terminal event. Slack's provider setup contribution
  registers one `plugin.ambitresearch.paperclip-agent-identities.slack-turn-drain` handler. Under that
  fresh event scope it drains one turn, resolves sender profile/session state, sends the bounded
  prompt, accumulates non-stderr output, and relays only filtered user-facing text. Threaded replies
  use Slack streaming; top-level/fallback replies use the provider post-message pipeline. Callbacks
  bind to the persisted accepted run ID, buffer pre-send-result events, ignore stale callbacks, and
  await reply finalization before completing/clearing/kicking the successor. Non-terminal callbacks
  are sequence-filtered, while the matching run's single terminal callback is accepted even when the
  Paperclip host resets its sequence to zero after streamed chunks. There is no detached
  host-calling timeout. A later webhook/self-event scope retires an expired 30-minute lease. Generic send errors
  are ambiguous and become uncertain/completed with no resend; only the host's exact
  `Session not found` / `Session not found or closed` class is retried
  safely on a replacement session. Restart plus a later webhook re-kicks persisted work, while
  restart after ack with no later trigger requires host durable scheduling/request-key support.
- `index.ts` is the shared Slack-ingress export barrel for bounded turn inputs/results,
  secret-free queue status/count/capacity summaries, bounded constants and conversation-key helpers,
  and strict `createSlackTurnDrainPayload` payloads. Provider registration, the one-turn drain seam, webhook
  declarations/handling, raw queue records, and mutable internal state transitions stay
  provider-private.
  `SlackConversationQueueFullError` and `SlackConversationStateConflictError`
  are exported for host-facing
  integration tests and adapters that need to preserve non-ack semantics;
  `isRetryableSlackQueueError` provides the stable code-based check.

Composed generically: `src/core/provider-contract.ts` adds an optional `webhooks`/`handleWebhook`
seam (mirroring the existing `manifestTools`/`liveTools()` pattern), `src/manifest.ts` declares the
`slack-events` endpoint through the registry, and `src/worker.ts` dispatches `onWebhook` deliveries
by `endpointKey` via the registry — no Slack-specific branch in either file. Unit/integration
tests cover URL verification, signature/timestamp rejection, routing ambiguity, authorization
lists, durable queue bounds/dedup, deferred self-event draining, callback ordering, uncertain sends,
restart recovery, and worker wiring (`tests/providers/slack/ingress-*.spec.ts`).

For temporary local testing, `scripts/slack-events-adapter.mjs` listens only on
`127.0.0.1:3110`, accepts `POST /events`, and forwards the unchanged request body and Slack headers
to the company-scoped Paperclip route:
`http://127.0.0.1:3100/api/companies/<companyId>/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events`.
It requires a valid `PAPERCLIP_COMPANY_ID`. A test-only public HTTPS tunnel or proxy can point its
`/events` route at this loopback adapter and be disabled after testing.

Still deferred: Socket Mode as an alternate transport, OAuth callback automation, and token
rotation.

## 11. Agent runtime boundary

This provider owns the complete Slack delivery and reply relay. It verifies and deduplicates the
event, resolves exactly one configured identity, opens a Paperclip plugin session for that agent,
and relays the completed response through either Slack's native streaming APIs or the provider tool
fallback. This uses the documented `ctx.agents.sessions.create`, `sendMessage`, and `close` SDK
methods. It also requires Paperclip core support for company-scoped webhook routing, worker response
propagation, config secret-ref patches, and scoped secret resolution. The pnpm patch in this plugin
updates the worker SDK surface only; an unmodified `2026.707.0` host is not compatible.

The agent interprets the bounded event prompt and returns plain text. The plugin, not the agent,
performs the Slack API call. This keeps Slack credentials in company config and secret refs, keeps
the deny-before-secret provider pipeline intact, and avoids depending on adapter-specific tool
injection or agent instructions.

A separate `paperclip-slack-agent` runtime must not register a second Events API receiver or consume
the same Slack delivery in parallel. If it is installed, disable its overlapping ingress path for
these apps. There should be one Request URL, one dedup owner, and one reply owner per Slack app.

## 12. MVP vs. deferred capability matrix

| Capability | MVP | Deferred |
| --- | --- | --- |
| One app/bot per agent, manifest copy/paste install | ✅ | |
| `slack_bot_whoami`, `slack_bot_post_message`, `slack_bot_add_reaction`, `slack_bot_remove_reaction` tools | ✅ | |
| `slack_bot_lookup_channel` tool | | ✅ |
| HTTP Events API receiver, routing, and dedup (DRO-1005) | ✅ (§10) | |
| Generated app Request URL and `message.im` subscription | ✅ (§5, §10) | |
| `app_mention` subscription and `app_mentions:read` scope | ✅ (§5, §10) | |
| Owned-thread follow-ups through channel message subscriptions | ✅ (§5, §10) | |
| Socket Mode | | ✅ (operator opt-in only, per decision record) |
| App Manifest API (`apps.manifest.*`) bulk automation | | ✅ (operator-only, per decision record) |
| In-house OAuth v2 install flow (vs. manifest copy/paste) | | ✅ |
| Channel allow-list authorization policy | | ✅ (possible hardening) |
| `channels:join` self-invite | | ✅ |
| Multi-workspace-per-agent | | ✅ |

## 13. Required vs. optional scopes (MVP)

**Required**: `assistant:write`, `app_mentions:read`, `chat:write`, `channels:history`,
`channels:read`, `groups:history`, `groups:read`, `im:history`, `mpim:history`,
`reactions:write`, and `users:read`. The history scopes back the generated message event
subscriptions. `users:read` lets setup resolve the App ID from the installed bot.

**Optional / deferred**: `channels:join` (only if self-invite ships).

## 14. No Slack-specific main-loop changes required

Confirms the acceptance criterion directly: every capability above is expressed through
`IdentityProvider` (`validateConfig`, `projectPluginConfig`, `resolveCredential`, `tools`,
`contributeActions`, `manifestTools`) or a provider-neutral host-config extension. Slack resolvers
read typed refs from the calling company's config snapshot and use `ctx.secrets.resolve`; there is
no Slack runtime credential-sidecar source kind; the explicit legacy migration
path is settings-only. `src/worker.ts` and
`src/manifest.ts` require zero new `if (provider === "slack")` branches; adding Slack is
`ALL_PROVIDERS: readonly IdentityProvider[] = [githubProvider, exampleProvider, slackProvider]`
in `src/providers/index.ts`, per the existing composition-root comment.

## Sources

- [`slack-provisioning-decision.md`](./slack-provisioning-decision.md) — DRO-965 research
  (pending merge, PR #66; content verified complete and unchanged as of 2026-07-11).
- [`agent-identities.md`](./agent-identities.md) documents the current `IdentityProvider` contract
  and provider composition model.
- `/src/core/provider-contract.ts`, `/src/core/agent-identity.ts`, `/src/core/resource-reference.ts`
  — exact TypeScript shapes referenced above.
- `/src/providers/github/index.ts`, `/src/providers/index.ts` — composition-root pattern this
  design follows for adding Slack without provider-specific branches elsewhere.

## Implementation status (DRO-969: credential storage and resolution)

The original DRO-969 slice introduced the identity and resolver shape. The current implementation
has since moved both Slack credential references into company-scoped host config as described in
§2. The bot token and signing secret are required typed refs. Released `v0.1.7`/`v0.1.8` Slack
sidecar refs can remain until an operator runs the one-release migration action; current Slack
runtime resolution never consumes them. Two boundaries remain unchanged:

- **Token rotation is unimplemented**, per the §2 MVP decision
  (`token_rotation_enabled: false`): there is no refresh-token storage, expiry tracking, or
  renewal scheduler. `resolveSlackBotToken` resolves a single long-lived Paperclip-secret-backed
  bot token and fails closed with no fallback; enabling rotation is out of scope until a future
  task lands the full refresh lifecycle as one unit.
- **Four Slack tools are live**: `slack_bot_whoami`, `slack_bot_post_message`,
  `slack_bot_add_reaction`, and `slack_bot_remove_reaction`. The post-message tool covers both
  top-level messages and threaded replies. They register through `toolsStatus: "enabled"` even
  though `slackProvider.definition.status` remains `"coming-soon"`. The deferred
  `slack_bot_lookup_channel` tool is the remaining gap; the provider status stays unchanged until
  that full tool surface lands.

## Implementation status (DRO-971: manifest-assisted app setup actions)

*(This section supersedes DRO-969's note above regarding DRO-971's own status — that note is
scoped to the five Slack tools, not the setup actions this section documents.)*

## Implementation status (DRO-973: slack_bot_post_message message/threaded-reply tool)

Adds `slackBotPostMessageToolSpec` (`src/providers/slack/tools/post-message.ts`), the first entry
in `slackProvider.tools`. A single tool covers both posting a new top-level message and posting a
threaded reply — the optional `threadTs` param (validated and carried on `SlackChannelRef` by the
existing `resolveSlackChannelRef`, §3) selects reply-vs-post; there is no separate
`slack-reply-thread` tool, since Slack's own `chat.postMessage` API takes the same `thread_ts`
parameter for both cases and a second tool spec would duplicate all of the validation/error/redaction
logic for no behavioral gain.

Follows the mandatory pipeline order (validate params -> resolve identity -> resolve resource ref ->
resolve credentials -> perform -> redact): `validateParams` rejects unknown keys, non-string/missing
`channel`/`text`, oversized `text` (over `SLACK_MESSAGE_TEXT_MAX_LENGTH`, a conservative bound under
Slack's ~40,000-char `chat.postMessage` limit), and oversized/malformed `blocks`; `resolveResourceRef`
delegates to `resolveSlackChannelRef` (§3) so a wrong-workspace `teamId` or malformed channel is
denied before any credential is resolved; `perform` reads the pipeline-resolved token defensively
(returns a stable internal error if it is ever `null`) and never interpolates the token into a log or
returned error string (`redact()` is defense-in-depth on top of that).

Required OAuth scope is `chat:write` (also covers threaded replies via `thread_ts` — no extra scope
needed); `chat:write.public` is optional/gated and this tool does not special-case it — a missing
grant simply surfaces as Slack's own `not_in_channel`/`missing_scope` error codes, translated into an
actionable message by `describeSlackError`. A `429` response is translated into a `rate_limited`
error carrying the `Retry-After` header value rather than throwing. On success, the tool fetches a
best-effort `chat.getPermalink` (a permalink lookup failure never fails the post itself) and returns
`{ team, conversation, messageTs, threadTs, permalink }`.

`slackProvider.definition.status` stays `"coming-soon"` purely because the *full* Slack tool
surface isn't finished yet — the manifest-assisted Slack settings UI (DRO-1025/#73) is already live
in Settings and already surfaces Slack in the provider picker. `toolsStatus` is set to `"enabled"`
independently, which is what actually gates live tool registration
(`registry.toolsEnabled()`/`liveTools()`, consumed by `worker.ts`/`manifest.ts`), so
`slack_bot_whoami`, `slack_bot_post_message`, `slack_bot_add_reaction`, and
`slack_bot_remove_reaction` are reachable now even though `status` has not flipped. Only
`slack_bot_lookup_channel` remains backlog work; once it lands, `status` flips to `"enabled"` too
and `toolsStatus` becomes redundant but harmless to keep.

This slice implements §6's `contributeActions` for Slack, wired through `slackProvider` in
`src/providers/slack/index.ts` exactly like `contributeGitHubAppManifestActions` is wired for
GitHub — no new `if (provider === "slack")` branch was added to `src/worker.ts` or
`src/manifest.ts` (the existing `provider.contributeActions?.(ctx)` loop was widened to run for
every registered provider, not just enabled ones, since a "coming-soon" provider like Slack can
still ship setup actions ahead of its tool surface; this is a provider-agnostic change, not a
Slack-specific one). Three actions are registered (`src/providers/slack/app-manifest.ts`):

- `create-slack-app-manifest`: validates the supplied HTTPS URL (no query, fragment, or embedded
  credentials) and builds the MVP app manifest with `request_url`, `app_mention`, direct-message events,
  channel thread events, and their required history scopes, while keeping `interactivity.is_enabled`,
  `socket_mode_enabled`, and `token_rotation_enabled` false. It
  verifies the
  target `agentId` belongs to the host-authorized `companyId` (via `ctx.agents.list`), generates a
  one-time `pc_`-prefixed `state`, and persists a short-lived (30-minute), company-scoped setup-state
  record via `ctx.state.set` keyed by `(companyId, agentId, provider, state)`. Returns the manifest
  JSON, `state`, and a plain `https://api.slack.com/apps?new_app=1` link to Slack's "create an app"
  entry point — **not** a prefilled deep link: Slack has no documented query parameter that
  prefills a manifest (see `slack-provider-design.md` §14), so the operator pastes the manifest
  JSON in manually via Slack's "From an app manifest" flow.
- `get-slack-app-manifest-flow`: reads back a flow by `state`, scoped to the calling company;
  rejects unknown, expired, or already-consumed state.
- `save-slack-install-metadata`: binds back to the setup-state flow by `state`, asserts the flow's
  `agentId` matches the caller-supplied `agentId` (so a replayed/duplicate callback cannot
  overwrite a *different* agent's identity), and validates both `botTokenSecretId` and
  `signingSecretId` as UUIDs before mutation. It claims the flow, persists
  `teamId`/`appId`/`botUserId`/`defaultChannel` into the `SlackAgentIdentityConfig` variant, then
  calls `ctx.config.patchSecretRefs` once to persist the company-scoped Slack subtree with typed
  `credentials.botToken` and `credentials.signingSecret` refs. The action never receives either raw
  secret. Neither action logs the one-time `state` value (it is
  short-lived secret material per `slack-provisioning-decision.md`).

**Reconciling this against the GitHub issue's acceptance-criteria language:** DRO-971's issue text
(and its acceptance criteria) describe "OAuth v2 state validation," "exchange the code," and "App
Manifest API automation." Those phrases describe capability classes this document and
[`slack-provisioning-decision.md`](./slack-provisioning-decision.md) explicitly deferred out of
MVP scope (see §1 above and that record's "Explicitly out of scope for MVP" list): automated
OAuth code exchange needs an OAuth callback route, Slack `client_id`/`client_secret` storage, and
a host-supported secret-*creation* API (`ctx.secrets` here exposes only `.resolve()`); this
plugin's inbound webhook route handles Events API deliveries only and is not an OAuth callback.
The App Manifest API (`apps.manifest.*`) bulk-creation
path needs a rotating 12-hour configuration token that is not modeled anywhere in this codebase.
Per this design record's own framing — "this document...is still the input for that follow-on
work" — the authoritative contract is what ships here: manifest JSON generation plus a
single `state`-bound, single-use, expiring operator-paste-back flow (`create` → `get` →
`save`), not an in-house OAuth callback or Manifest-API automation. A future issue that lands
public inbound routing, secret-*creation*, and config-token storage is the correct place to build
the deferred flows described in §1/§7 and in `slack-provisioning-decision.md`'s "OAuth v2 install
flow (for reference / future automation)" section — this slice does not attempt them.

**Operator-facing UI landed in a follow-up (DRO-1025).** At the time this DRO-971 slice merged,
`src/ui/SettingsPage.tsx` only wired GitHub's manifest actions and did not call
`create-slack-app-manifest`, `get-slack-app-manifest-flow`, or `save-slack-install-metadata`. That
gap has since been closed: the Slack settings-UI flow (manifest display + copy/paste-back form,
mirroring the GitHub pattern) is now implemented as a provider-owned adapter in
`src/providers/slack/settings-adapter-ui.tsx` (see `ProviderSettingsUIAdapter` in
`src/core/provider-settings-ui-contract.ts`), giving operators an end-to-end create/install path
for a Slack app from the UI. `slackProvider.definition.status` intentionally still stays
`"coming-soon"`. That flag now gates strictly on the full Slack tool surface, not on setup-UI
availability. With DRO-972/973/974 landed, only `slack_bot_lookup_channel` (DRO-975) remains before
`status` flips to `"enabled"`.

## Implementation status (DRO-974: reaction tools)

This slice implements two of the five Slack tools described in §4:
`slack_bot_add_reaction` and `slack_bot_remove_reaction`
(`src/providers/slack/tools/react.ts`), wired through `slackProvider.tools` in
`src/providers/slack/index.ts` and `slackProvider.manifestTools` via the new
`src/providers/slack/manifest-tools.ts` — no `if (provider === "slack")`
branch was added to `src/worker.ts` or `src/manifest.ts`.

- Both tools share one parameter schema
  (`src/shared/slack-bot-reaction-tool-definition.ts`): `messageTs` (required,
  `^[0-9]{10,}\.[0-9]{6}$`), `reaction` (required, emoji name without colons,
  `^[a-z0-9_+-]+$`, 1-100 chars), and optional `channelId`/`teamId`. Unknown
  fields are rejected. All of this is validated in `validateParams` — entirely
  locally, before identity/resource-ref/credential resolution — per the
  "validate emoji and timestamp locally" acceptance criterion.
- `resolveResourceRef` resolves a `SlackChannelRef` via the existing
  `resolveSlackChannelRef` helper (`src/providers/slack/channel-ref.ts`,
  DRO-967/§9's cross-workspace guard): an explicit `channelId` wins, otherwise
  the identity's configured `defaultChannel` is used; if neither exists,
  resolution fails closed. A `teamId` param that doesn't match the identity's
  own `teamId` is denied here — strictly before any credential is
  resolved — satisfying "wrong-team references fail before credentials."
- `perform` calls Slack's `reactions.add`/`reactions.remove` via
  `ctx.http.fetch`, scoped to the `reactions:write` bot scope only (already
  present in `SLACK_MVP_BOT_SCOPES`, `src/providers/slack/app-manifest.ts`).
  Only `reactions.add`'s `already_reacted` is treated as a caller-idempotent
  no-op (reports `action: "added"`), per the "duplicate reactions are
  caller-idempotent and tested" acceptance criterion. `reactions.remove`'s
  `no_reaction` is deliberately NOT treated as idempotent success: Slack
  returns that same code both when the reaction is already absent AND when
  the reaction belongs to a different user/bot, and `reactions.remove` can
  only remove a reaction the calling bot itself added (see §6 above). Since
  the tool cannot distinguish those two cases from the response alone,
  reporting success either way would falsely claim a removal that may never
  have happened — so `no_reaction` falls through to the generic error path
  and fails closed with a `{ error }` result, per §6's documented Slack API
  limitation. `channel_not_found` and other real Slack API errors also fail
  closed the same way. The result never includes the token or a raw Slack
  response body; the shared pipeline's redact step also strips the resolved
  token/secrets from whatever `perform` returns. Network-level failures
  (thrown before a response is received) are logged with a non-secret
  classification only — the raw thrown error message is never logged, since
  an HTTP adapter error can embed request details and the bot token is
  already in the outgoing `Authorization` header by that point.
- `slackProvider.definition.status` stays `"coming-soon"`: with
  `slack_bot_whoami` (DRO-972/#59) and `slack_bot_post_message` (DRO-973/#60)
  now also landed alongside this slice's two reaction tools. Only
  `slack_bot_lookup_channel` (DRO-975) remains
  still-backlog, so the identity isn't surfaced as fully ready yet.
  `slackProvider.definition.toolsStatus` is set to `"enabled"` independently
  of `status`: this is the provider-neutral gate
  `registry.toolsEnabled()`/`registry.liveTools()` use (consumed by
  `src/worker.ts`'s registration loop and `src/manifest.ts`'s tool list)
  instead of `.enabled()`, so all four already-implemented tools are
  reachable now even though `status` hasn't flipped to `"enabled"`.
- Test coverage: `tests/providers/slack/react-tool.spec.ts` — local
  validation (valid/invalid messageTs, reaction, channelId, teamId, unknown
  fields), resource-ref resolution (default-channel fallback, missing default
  channel, wrong-team denial with no credential/API call attempted),
  `perform` for both tools (success, idempotent no-op, real API error,
  token-redaction on a thrown network error), and two full pipeline
  round-trips through `createProviderTool` covering both the happy path and
  the wrong-team-denies-before-credential path end-to-end.

## Implementation status (DRO-1161: live Slack connection health in Settings)

`slack_bot_whoami` (§ "Implementation status (DRO-969...)" above) was always a
credential-free echo of stored public metadata — it has never made a live
Slack call. During an incident, that let the Settings UI report an identity
as effectively "Ready" while every inbound mention was actually failing
before it ever reached the queue: Configured, Connection, Ingress, and
Delivery had all collapsed into a single undifferentiated state.

DRO-1161 adds a **second, separate** live check —
`src/providers/slack/connection-status.ts` — that performs a bounded,
server-side Slack `auth.test` against the *resolved* bot credential and
reuses `resolveSlackBotToken`'s existing fail-closed checks (workspace match,
bot-vs-user-token rejection, configured `botUserId` match). "Connection: ok"
therefore means exactly what tool/reply credential resolution would also
accept — not a separately-defined, weaker notion of "connected".

- **New settings action**: `check-slack-connection`, registered by
  `contributeSlackConnectionStatusAction` (called from
  `contributeSlackActionsAndIngress` in `src/providers/slack/index.ts`
  alongside the existing manifest-flow actions). Human-actor-gated
  (`requireHumanSettingsActor` is implicit via the same
  `PluginPerformActionContext`), company-scoped (`context.companyId`, never
  a caller-supplied `params.companyId`), and bounded by an 8s internal
  timeout (`SLACK_CONNECTION_CHECK_TIMEOUT_MS`) so a hanging Slack API call
  cannot hang the settings action indefinitely.
- **Bounded, secret-free response shape**: `{ outcome: { ok: true } |
  { ok: false, category, reason }, checkedAt, nextStep? }`. `category` is one
  of a small closed set (`credential_missing`, `credential_resolution_failed`,
  `auth_test_failed`, `workspace_mismatch`, `identity_mismatch`,
  `network_failed`, `timeout`, `unknown`) — never a raw Slack error string,
  response body, header, or stack trace. The check tags each stage
  (secret resolution vs. `auth.test` verification) so only a genuine secret
  resolution rejection maps to `credential_resolution_failed`; a
  transport/DNS throw while reaching Slack maps to `network_failed`, and
  anything else falls through to `unknown` rather than blaming the secret
  reference. `nextStep` is a fixed, per-category guidance string (see
  `CONNECTION_FAILURE_GUIDANCE`), satisfying the "next-step guidance for
  credential ... failures" acceptance criterion for the credential/routing
  half of DRO-1161's scope.
- **UI**: `src/providers/slack/settings-adapter-ui.tsx` renders a new
  `SlackConnectionStatusPanel`, separate from the existing `SlackStatusPanel`
  (which still only reflects saved/configured metadata and is now annotated
  as such). The Connection panel has its own loading/error/result state
  (`slackConnectionStatus*`), an explicit "never tested" state before the
  first check, an operator-triggered "Check Slack connection" button
  (`handleCheckSlackConnection`), and marks a previously-successful result
  **stale** once it is older than `SLACK_CONNECTION_STATUS_STALE_AFTER_MS`
  (5 minutes) rather than implying continuous health from an old success. A
  refresh failure (the action itself erroring, e.g. a network blip reaching
  the plugin action bridge) preserves the last known result and shows it
  alongside the error, per "UI preserves the last known state on refresh
  failure and marks it stale."
- **Scope of this increment**: this lands the full
  **Configured / Connection / Ingress / Delivery** split described in
  DRO-1161's "Required states". Configured and Connection are implemented as
  described above; **Ingress** (most recent verified event time/type and
  routing result) and **Delivery** (enqueue/drain/session-start/completion/
  failure phase) are implemented alongside them in
  `src/providers/slack/telemetry.ts`, recorded from
  `src/providers/slack/ingress/provider-webhook.ts` against
  `src/providers/slack/ingress/conversation-session.ts`'s existing
  queue/session state rather than adding a new live network call — see
  "Implementation status (DRO-1187)" below. **Durable queue recovery remains
  out of scope** here and is tracked as the separate recovery issue.
- Test coverage: `tests/providers/slack/connection-status.spec.ts` — healthy
  `auth.test` round trip (asserts the response never contains the token),
  auth-rejected credential, workspace mismatch, user-token
  (missing `bot_id`) rejection, missing secret reference
  (`credential_missing`, no network call attempted), a secret-resolution
  rejection (`credential_resolution_failed`, no network call attempted), a
  bounded timeout on a hung `fetch` (via `vi.useFakeTimers`), token-redaction
  on a Slack error body that happens to echo the token back, and the
  registered `check-slack-connection` action itself (missing `agentId`,
  missing `companyId`, no configured identity, and a full round trip
  asserting the returned payload never contains a token-shaped string).

## Implementation status (DRO-1187: deferred Ingress and Delivery telemetry in Settings)

Completes the Configured/Connection/Ingress/Delivery split named in DRO-1161's
"Required states" and left as a follow-up above. Unlike Connection (a live,
on-demand `auth.test` call), Ingress and Delivery are **recorded**, not
checked on demand: `src/providers/slack/telemetry.ts` persists one small
bounded record per (companyId, agentId) as real webhook/queue/session
activity happens, and Settings only *projects* the most recent record back.

- **Storage**: one bounded, `structuredClone`-serializable record per agent,
  keyed the same way `conversation-session.ts` scopes its durable queue
  state (`scopeKind: "agent"`), under a dedicated `slack-telemetry` plugin
  state namespace (never mixed into `SLACK_CONVERSATION_STATE_NAMESPACE`, so
  telemetry recording can never contend with or corrupt queue ownership).
  Fields are strictly bounded: ISO-shaped/epoch-ms timestamps, closed enum
  categories, and the same correlation-safe `teamId`/`appId` identifiers
  already treated as safe elsewhere in this provider — **never** message
  text, prompts, model output, tokens, signing secrets, HTTP headers, or
  stack traces. There is deliberately no caller-supplied free-text `reason`
  field anywhere in the persisted record: every failure carries only a
  closed-enum `category` and that category's fixed, static `nextStep`
  guidance string (`SLACK_INGRESS_FAILURE_GUIDANCE` /
  `SLACK_DELIVERY_FAILURE_GUIDANCE`), so there is no per-call text a caller
  could ever need to bound, redact, or accidentally leak operational detail
  through. Reads are additionally scoped by the caller's authorized
  `companyId`: because the state key is keyed by `agentId` alone, a stored
  record's own `companyId` is checked against the caller's before it is ever
  returned, so knowing (or guessing) a valid `agentId` can never disclose
  another company's ingress/delivery telemetry for that agent.
- **Ingress** (pre-queue, recorded via an optional `recordIngressOutcome` dep
  threaded through `handleSlackWebhook` in `webhook-handler.ts` — kept a pure
  callback seam, exactly like `onAgentEvent`/`shouldProcessEvent`, so the
  handler itself never touches state/db directly): records the most recent
  verified event's timestamp and a bounded event-type category (`message` |
  `app_mention` | `other` — never raw event/text content) plus routing result
  (`routed` | `routing_failed`) on success, and a bounded failure (category
  `signature_failed` | `routing_failed`, fixed operator guidance, timestamp)
  on failure. A post-signature routing failure is attributed to the one
  identity whose secret already matched — the only safe scope, since the
  request is by then authenticated. A pre-signature failure (no identity has
  authenticated this raw body yet) is **never** attributed to any identity,
  including a routing-hint-named candidate: `team_id`/`api_app_id` are
  attacker-controlled input at that point, and attributing to them would let
  anyone who merely knows or guesses a configured team/app pair poison that
  identity's ingress health without ever proving control of the signing
  secret.
- **Delivery** (post-queue, recorded from `provider-webhook.ts`, which is the
  only ingress module that already touches `ctx.state`/`ctx.agents.sessions`):
  records enqueue, drain/session-start, completion, and failure phase
  transitions at the existing call sites — `enqueueSlackConversationTurn`
  success/failure, `kickSlackConversation` success/failure, and
  `finishAcceptedRun`'s/`finalizeAmbiguousSend`'s/`retireBlockingTurn`'s
  terminal outcomes. `drain_started` is recorded from `startClaimedTurn` once
  a session has actually been claimed/resolved for the turn — not at the
  point a queue-drain self-event kick is merely scheduled, which proves only
  that an event was enqueued, not that draining ever began. Failure
  categories are `queue_failed` (durable queue full or conflicted),
  `session_failed` (session create/resume/kick/lifecycle failure), and
  `reply_failed` (an ambiguous or failed reply send, classified the same way
  `classifySlackSendFailure` already does for retry safety). All telemetry
  writes are wrapped to never throw — a telemetry write failure must never
  affect queue ownership, session lifecycle, or webhook acknowledgement.
- **New read-only settings action**: `get-slack-telemetry`, registered by
  `contributeSlackTelemetryAction` alongside `check-slack-connection` in
  `contributeSlackActionsAndIngress`. Company-scoped and `agentId`-validated
  identically to `check-slack-connection` — the resolved `context.companyId`
  is passed through to `getSlackTelemetry` and enforced against the stored
  record's own `companyId` (see Storage above); returns
  `{ ingress: SlackIngressTelemetry | null, delivery: SlackDeliveryTelemetry
  | null }`, with `null` (rendered as "Never observed") rather than an error
  when nothing has ever been recorded for that agent, or when a record
  exists but belongs to a different company.
- **UI**: `src/providers/slack/settings-adapter-ui.tsx` adds
  `SlackIngressStatusPanel` and `SlackDeliveryStatusPanel`, rendered next to
  `SlackConnectionStatusPanel`. Unlike Connection, neither has a manual
  "check" button — there is no live check to trigger, only a projection of
  already-recorded activity — so both are fetched via
  `handleRefreshSlackTelemetry` (`get-slack-telemetry`) automatically
  whenever the viewed identity changes, mirroring how `refresh()` is already
  used elsewhere in this hook. On a refresh failure, the last-known
  telemetry is preserved (not cleared) and marked stale once older than
  `SLACK_TELEMETRY_STALE_AFTER_MS` (5 minutes, the same window as
  Connection's `SLACK_CONNECTION_STATUS_STALE_AFTER_MS`) — identical pattern
  to `SlackConnectionStatusPanel`'s staleness handling. `SettingsPage.tsx`
  wires the new `get-slack-telemetry` plugin action through the same
  `usePluginAction` seam as `check-slack-connection`.
- Test coverage: `tests/providers/slack/telemetry.spec.ts` (healthy record,
  never-observed projection, routing/signature/queue/session/reply failure
  categories with their guidance strings, the full
  enqueue-drain-completed delivery lifecycle, per-agent scoping, a
  cross-company scoping test proving a shared `agentId` never leaks another
  company's record, and the registered `get-slack-telemetry` action's
  validation including its own cross-company case); plus focused wiring
  regressions in `tests/providers/slack/ingress-webhook-handler.spec.ts` (a
  healthy verified event, a post-signature routing failure, and a
  pre-auth signature failure that asserts no ingress outcome is recorded at
  all) and `tests/providers/slack/ingress-provider-webhook.spec.ts` (a
  routed ingress event through the real webhook path, a queue-full delivery
  failure under a enqueue burst, delivery completion through a full
  webhook -> enqueue -> drain -> completion round trip, and a regression
  proving `lastDrainStartedAt` is absent immediately after enqueue and only
  appears once the drain worker actually claims/starts the turn) reusing
  this suite's existing `makeCtx`/`delivery`/`runtime` fixtures rather than
  duplicating route/service setup.
