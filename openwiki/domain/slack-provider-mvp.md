# Slack provider MVP — contract, product boundary, threat model

Status: **partially implemented**. The identity-config slice (`src/providers/slack/config.ts`) and
the credential resolver (`resolveSlackBotToken` / `resolveSlackCredential` in
`src/providers/slack/credentials.ts`), composed through `src/providers/index.ts` per the existing
`IdentityProvider` contract
(`/src/core/provider-contract.ts`, see `agent-identities.md`), now exist and are covered by tests.
Actual Slack tools (posting messages, reacting, etc.) and inbound Events API handling remain
**disabled/deferred** — this document, together with
[`slack-provisioning-decision.md`](./slack-provisioning-decision.md), is still the input for that
follow-on `feat(providers): add Slack tools` work.

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
    defaultChannel?: string; // optional channel name/ID the agent posts to by default
  };
};
```

No Slack credential (bot token, signing secret, app-level token) ever appears in this type —
consistent with `github.username`/`github.commitName` holding only shareable identity metadata
while `credential-sidecar.ts` holds the private key path.

## 2. Install metadata vs. credential references

Mirrors the GitHub App / credential-sidecar split exactly:

- **Public identity config** (`identities[agentId:slack]` in `bot-identity-config`, v4 settings
  state): `teamId`, `appId`, `botUserId`, `defaultChannel` — all shareable per the decision
  record's shareable/secret table.
- **Credential sidecar** (`/src/credential-sidecar.ts`, extended with a new source kind): a new
  `slackBotToken` credential source —

  ```json
  {
    "identities": {
      "<agent-id>:slack": {
        "slackBotToken": {
          "botTokenSecretId": "<paperclip-secret-uuid>",
          "signingSecretId": "<paperclip-secret-uuid>"
        }
      }
    }
  }
  ```

  Both fields resolve through Paperclip secrets (the existing `secretId` fallback pattern), never
  a plaintext sidecar field and never a `tokenFile` fallback for the signing secret (it is used for
  per-request HMAC verification, not bearer auth, so it must not be written to a file the way a
  GitHub PEM is).

  **Rotation decision: MVP disables Slack token rotation (`token_rotation_enabled: false`).**
  Tracking a single extra refresh-token reference is not a complete rotation contract: rotated bot
  tokens expire after 12 hours, and refreshing one requires `oauth.v2.access` with the rotating
  refresh token *and* the app's `client_id`/`client_secret`, followed by durable atomic replacement
  of both the access and refresh tokens on every renewal. None of the client-credential storage,
  expiry metadata, or renewal semantics exist in this sidecar shape or in the current plugin SDK
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
Translating a human-readable channel *name* to an ID requires a token and is the credentialed
`slack-lookup-channel` tool's job (§4) — callers that only have a channel name must call that tool
first and pass its resolved ID into the posting tools. A channel ID that doesn't validate
syntactically, or one outside an allow-list (if one is configured), is denied at this step; Slack's
own membership/ACL check happens later, in the credentialed `perform` step, and is the actual
authorization boundary (see §9, "Confused-deputy posting" mitigation).

## 4. Tools (mapped 1:1 to minimum bot scopes from the decision record)

| Tool | `requiresCredential` | Scope | Resource ref |
| --- | --- | --- | --- |
| `slack-whoami` | `true` (must resolve the bot token to call the authenticated `auth.test`) | none (`auth.test`) | none |
| `slack-post-message` | `true` | `chat:write` | `SlackChannelRef` |
| `slack-reply-thread` | `true` | `chat:write` (thread_ts param, no separate scope) | `SlackChannelRef` |
| `slack-react` | `true` | `reactions:write` | `SlackChannelRef` |
| `slack-lookup-channel` | `true` (needs a token to call `channels.list`/`conversations.info`) | `channels:read`, `groups:read` | none (this tool *produces* a ref) |

No `slack-join-channel` tool in MVP — `channels:join` is listed as optional/deferred in the
decision record; omit until a concrete need surfaces (least-privilege: don't request or wire a
scope with no consuming tool).

`slack-whoami` is credentialed unlike GitHub's local `github-whoami`: GitHub's whoami echoes
configured metadata with no API call, but Slack's `auth.test` is itself an authenticated call that
verifies the live installation (team/user/bot identity) and requires the resolved bot token. A
missing or unresolvable secret therefore fails in the shared credential-resolution step, before the
tool body runs, rather than the tool silently returning stale configured values.

## 5. Manifest fragments

`IdentityProvider.manifestTools` is flattened directly into the composed Paperclip plugin
manifest's tool declarations — it is not a place to attach an external provider's own app-manifest
template, and doing so would also leave the five Slack tools (§4) without their required
plugin-manifest tool declarations. `manifestTools` therefore declares only the five Slack tools'
Paperclip-facing metadata (names, descriptions, param schemas), exactly like GitHub's
`manifest-tools.ts` declares its tools. The Slack **app**-manifest JSON generation (the
`{{agentLabel}}`/`{{workerHost}}`-parameterized template from the decision record) lives in the
contributed action instead (§6, `create-slack-app-manifest`), matching where GitHub's own App
manifest generation lives (`contributeGitHubAppManifestActions`), not in `manifestTools`.

Because MVP explicitly defers Events API ingress (§10) and never configures `app_mentions:read`,
the generated MVP app manifest has **no** `settings.event_subscriptions` block at all — not a
event-subscriptions block pointing at a Request URL that doesn't exist yet. Slack verifies a
Request URL as soon as event subscriptions are configured, so including that block in the MVP
manifest would either fail verification against a non-existent endpoint or silently reintroduce
the deferred ingress capability. `settings.interactivity.is_enabled: false` remains correct and is
unaffected by this.

## 6. Actions (`contributeActions`)

Mirrors `contributeGitHubAppManifestActions`: a `create-slack-app-manifest` worker action that
builds the per-agent manifest JSON and returns the plain `https://api.slack.com/apps?new_app=1`
"create app" URL alongside it (Slack has no documented query parameter to prefill a manifest, so
this is not a deep link — see §7), and a `save-slack-install-metadata` action the settings UI
calls once the
operator finishes Slack's own click-through install. This action's input is **not** limited to the
shareable IDs (`teamId`/`appId`/`botUserId`) — the credential source in §2 requires at least a
`botTokenSecretId` reference before any credentialed Slack tool can resolve successfully. There is
no supported host/plugin API for a worker action to create a Paperclip secret from a raw token
(`ctx.secrets` exposes only `resolve`, and the manifest capability is only `secrets.read-ref` — see
§7), so the action cannot mint that secret itself. The explicit sequence is:

1. Operator completes Slack's install click-through and copies the resulting Bot User OAuth Token
   (`xoxb-...`) from Slack's own UI.
2. Operator creates a Paperclip company secret through the host UI (outside this plugin) containing
   that token, and copies the resulting secret UUID.
3. Operator pastes `teamId`, `appId`, `botUserId`, and the secret UUID into the settings form.
   `save-slack-install-metadata` persists the shareable IDs to the public identity config and writes
   the UUID to the `slackBotToken.botTokenSecretId` sidecar entry (§2) — it never receives or
   stores the raw token itself.

(no OAuth code exchange in MVP — Slack's copy/paste manifest flow produces the bot token via its
own UI, not a callback we handle). This is a deliberately smaller flow than GitHub's manifest
conversion, because there is no documented Slack mechanism to prefill a manifest via URL and so no
GitHub-style "exchange code for PEM" step either; the operator relays back shareable IDs plus one
secret reference, not the token itself.

## 7. UI contributions

Adds a Slack section to `/src/ui/SettingsPage.tsx` alongside GitHub, following the same
add/edit/delete-one-identity-per-provider-per-agent pattern, prefilling `label` from agent
display name + company (same convention). No propagated environment variables in MVP — unlike
GitHub App credentials, which the worker pushes into the agent's adapter environment
(`GITHUB_APP_ID` etc.), Slack bot tokens should NOT be propagated as adapter env vars, because
Slack tool calls go through the provider's `resolveCredential` → sidecar path, not an
env-var-injected client the agent process constructs itself. This avoids adding a second path by
which a Slack token could land in an agent's environment/logs.

## 8. One-app-per-agent naming, workspace constraints, channel authorization, install ownership

- **Naming**: `Paperclip Agent — {{agentLabel}}` per the canonical manifest template, matching the
  decision record's requirement that distinct visible Slack identities need distinct apps (bot
  identity is per-app, not per-token).
- **Workspace constraint**: each agent's Slack app installs into exactly one workspace (`teamId`),
  chosen by the operator during the manifest deep-link flow. Multi-workspace agents are out of MVP
  scope — would need one identity config entry per `(agentId, teamId)` pair, deferred.
- **Channel authorization**: MVP does not implement its own authorization layer (same posture as
  GitHub — "Provider authorization" section of `agent-identities.md`: this repo maps identities to
  credentials and lets the provider's own permission model do the enforcing). For Slack that means
  channel-level authorization is Slack's own: the bot can only post/react/read in channels it has
  been invited to (or that are public and it has `channels:read` for lookup only, not necessarily
  post rights without membership). No allow-list config is required for MVP; document that an
  operator-configured channel allow-list is a possible deferred hardening step.
- **Install ownership**: the operator who opens the "create app" link, pastes in the manifest, and
  completes the Slack "Install to Workspace" click-through owns the resulting app at the
  Slack-workspace-admin level. Paperclip only receives back the bot token (via secret) and
  shareable IDs — it never becomes a Slack workspace admin.

## 9. Threat model

| Threat | Mitigation |
| --- | --- |
| **Credential disclosure** (bot token / signing secret / refresh token leaked via config, logs, git, tool output) | Same invariant as GitHub: `resolveCredential` mints/reads the token just-in-time from the sidecar (Paperclip-secret-backed), never persisted in `AgentIdentityConfig`, never returned by any tool `perform()`. Follows the mandatory pipeline order (validate params → resolve identity → resolve resource ref → resolve credentials → perform → redact) so a credential is only in memory for the shortest possible window. |
| **Confused-deputy posting** (agent A's tool call posts using agent B's Slack identity) | `resolveAgentIdentity()` keys strictly off `runContext.agentId` (same as GitHub) — there is no cross-agent identity parameter a tool call can supply. Because Slack identity is 1 app/bot-user per agent, there is no shared-token surface for a mixup to exploit (unlike a hypothetical shared workspace app). |
| **Forged OAuth callbacks** | MVP doesn't implement an OAuth callback at all (manifest deep-link + operator paste-back of IDs only) — this threat class is deferred until/unless an in-house OAuth install flow is built, at which point the decision record's OAuth section (state validation, exact redirect-URI match) is the mandatory implementation baseline. |
| **Replayed events** (inbound Events API POSTs replayed by an attacker) | Deferred to when inbound event handling ships (see §10) — the Events API path must verify `X-Slack-Signature`/`X-Slack-Request-Timestamp` per the decision record's HTTP-vs-Socket-Mode section, AND reject requests with a timestamp outside a small window (Slack's own recommended ±5 min) to bound replay. |
| **Cross-workspace IDs** (a `teamId`/`channel` ref from workspace X accidentally used against workspace Y's token) | `SlackChannelRef.teamId` is carried alongside `channel` through `resolveResourceRef`; the tool must assert `identity.slack.teamId === ref.teamId` before calling `perform`, the same "expectedRepository mismatch guard" pattern GitHub's push tool already uses for cross-repo mixups. |
| **Revoked tokens** (bot token revoked/uninstalled mid-operation) | `resolveCredential` calls fail closed (matching `fail closed with stable error on credential resolution failure`, already implemented for GitHub in `f8baa63`) — a Slack API 401/`invalid_auth` response surfaces as a tool error, not a silent no-op or retry-with-stale-token. |
| **Logging** (accidental token/signing-secret leakage into structured logs or error messages) | Errors from Slack API calls must be sanitized the same way GitHub App token errors already avoid returning secret values (see "GitHub App token minting" section of `agent-identities.md`) — never log full request/response bodies for Slack `oauth.v2.access`, `apps.manifest.*`, or Events API signature-verification failures. |

## 10. Inbound events — ship or defer?

**Decision: defer inbound event handling from MVP.** MVP tools are all agent-initiated
(post/reply/react/lookup) via `slack-whoami`-style just-in-time credential resolution — no
long-running listener needed. Shipping `app_mention` inbound events requires:

- a durable HTTPS Request URL endpoint on the Paperclip-hosted worker (deferred — needs its own
  signature-verification, ack-within-3s, and retry-dedup implementation, plus a decision on how an
  inbound Slack event maps to triggering an agent run, which is a product decision beyond this
  provider's scope);
- the replay/timestamp-window mitigation in §9.

Recorded as a downstream, not-yet-scoped task. If/when it ships, it is transport `HTTP Events API`
(not Socket Mode) per the decision record, added as a new worker route composed through the
provider registry the same way `contributeActions` composes today — not a new `worker.ts`
provider-specific branch.

## 11. Coexistence with the `paperclip-slack-agent` plugin

The installed `paperclip-slack-agent` plugin is (per its name) a Slack-facing *agent runtime*
integration — it is the thing that would consume inbound Slack events to drive agent turns. This
provider (`agent-identities`) is scoped narrowly to **identity/credential custody**: it owns the
Slack app manifest, bot token, and per-agent identity mapping, exactly as it owns GitHub App
identity today and nothing about GitHub's CI/PR-automation logic. The boundary:

- **This provider owns**: Slack app creation (manifest), credential sidecar storage, `resolveCredential`,
  and narrowly-scoped tools (`post-message`, `reply-thread`, `react`, `lookup-channel`, `whoami`).
- **`paperclip-slack-agent` (if/when it needs Slack credentials) owns**: consuming those
  credentials/tokens via the same `resolveIdentityForProvider()`/registry surface other Paperclip
  code already uses to read a provider identity — it should not mint or store its own separate copy
  of a Slack bot token. If `paperclip-slack-agent` already has its own token acquisition path, that
  is a duplication to reconcile before this provider ships, not something to silently ignore; flag
  it explicitly in the implementation task rather than merge two credential stores for the same
  Slack app.
- Responsibilities do not collide because this provider does not run any inbound listener or agent
  dispatch logic (see §10) — it purely supplies identity + credentialed tool calls.

## 12. MVP vs. deferred capability matrix

| Capability | MVP | Deferred |
| --- | --- | --- |
| One app/bot per agent, manifest deep-link install | ✅ | |
| `slack-whoami`, `-post-message`, `-reply-thread`, `-react`, `-lookup-channel` tools | ✅ | |
| HTTP Events API inbound (`app_mention`) | | ✅ (§10) |
| Socket Mode | | ✅ (operator opt-in only, per decision record) |
| App Manifest API (`apps.manifest.*`) bulk automation | | ✅ (operator-only, per decision record) |
| In-house OAuth v2 install flow (vs. manifest deep-link + paste-back) | | ✅ |
| Channel allow-list authorization policy | | ✅ (possible hardening) |
| `channels:join` self-invite | | ✅ |
| Multi-workspace-per-agent | | ✅ |

## 13. Required vs. optional scopes (MVP)

**Required** (backing the five MVP tools): `chat:write`, `channels:read`, `groups:read`,
`reactions:write`.

**Optional / deferred**: `app_mentions:read` (only needed once inbound events ship, §10),
`channels:join` (only if self-invite ships).

## 14. No Slack-specific main-loop changes required

Confirms the acceptance criterion directly: every capability above is expressed through
`IdentityProvider` (`validateConfig`, `projectPluginConfig`, `resolveCredential`, `tools`,
`contributeActions`, `manifestTools`) or a small provider-neutral extension (the new
`slackBotToken` credential-sidecar source kind, added generically the way `secretId`/`tokenFile`
already are — not a Slack-only branch in the sidecar's resolution order). `src/worker.ts` and
`src/manifest.ts` require zero new `if (provider === "slack")` branches; adding Slack is
`ALL_PROVIDERS: readonly IdentityProvider[] = [githubProvider, exampleProvider, slackProvider]`
in `src/providers/index.ts`, per the existing composition-root comment.

## Sources

- [`slack-provisioning-decision.md`](./slack-provisioning-decision.md) — DRO-965 research
  (pending merge, PR #66; content verified complete and unchanged as of 2026-07-11).
- [`agent-identities.md`](./agent-identities.md) — current `IdentityProvider` contract, GitHub
  implementation, and credential-sidecar model this design mirrors.
- `/src/core/provider-contract.ts`, `/src/core/agent-identity.ts`, `/src/core/resource-reference.ts`
  — exact TypeScript shapes referenced above.
- `/src/providers/github/index.ts`, `/src/providers/index.ts` — composition-root pattern this
  design follows for adding Slack without provider-specific branches elsewhere.

## Implementation status (DRO-969: credential storage and resolution)

This slice implements the identity config shape (§1), the `slackBotToken` credential-sidecar
source and its resolver (§2), and the `slackProvider` composition (§14) — with `tools: []` and
`manifestTools: []`. Two things called out above are deliberately **not** part of this slice:

- **Token rotation is unimplemented**, per the §2 MVP decision
  (`token_rotation_enabled: false`): there is no refresh-token storage, expiry tracking, or
  renewal scheduler. `resolveSlackBotToken` resolves a single long-lived Paperclip-secret-backed
  bot token and fails closed with no fallback; enabling rotation is out of scope until a future
  task lands the full refresh lifecycle as one unit.
- **The five Slack tools** (`slack-whoami`, `slack-post-message`, `slack-reply-thread`,
  `slack-react`, `slack-lookup-channel`, §4) are out of scope for this issue — they are separate,
  blocked issues DRO-973/974/975. `slackProvider.definition.status` therefore stays
  `"coming-soon"` and `tools`/`manifestTools` stay empty until those issues land.

## Implementation status (DRO-971: manifest-assisted app setup actions)

This slice implements §6's `contributeActions` for Slack, wired through `slackProvider` in
`src/providers/slack/index.ts` exactly like `contributeGitHubAppManifestActions` is wired for
GitHub — no new `if (provider === "slack")` branch was added to `src/worker.ts` or
`src/manifest.ts` (the existing `provider.contributeActions?.(ctx)` loop was widened to run for
every registered provider, not just enabled ones, since a "coming-soon" provider like Slack can
still ship setup actions ahead of its tool surface; this is a provider-agnostic change, not a
Slack-specific one). Three actions are registered (`src/providers/slack/app-manifest.ts`):

- `create-slack-app-manifest`: builds the MVP app manifest (minimum bot scopes only, no
  `settings.event_subscriptions` block, `interactivity.is_enabled: false`,
  `socket_mode_enabled: false`, `token_rotation_enabled: false` — per §5 above), verifies the
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
  overwrite a *different* agent's identity), validates `botTokenSecretId` as a UUID before any
  mutation (matching the credential-sidecar schema, so an invalid reference fails atomically
  instead of after settings state is already persisted), claims the flow (marks it consumed) before
  performing the settings/credential-sidecar writes to shrink the window for a concurrent duplicate
  callback, persists `teamId`/`appId`/`botUserId`/`defaultChannel` into the
  `SlackAgentIdentityConfig` variant, and writes `slackBotToken.botTokenSecretId` into the
  credential sidecar via the existing `upsertCredentialSidecarIdentity` helper. The action never
  receives or stores a raw bot token — only the Paperclip secret UUID the operator already created
  via the host UI, per §6 step 2 above. Neither action logs the one-time `state` value (it is
  short-lived secret material per `slack-provisioning-decision.md`).

**Reconciling this against the GitHub issue's acceptance-criteria language:** DRO-971's issue text
(and its acceptance criteria) describe "OAuth v2 state validation," "exchange the code," and "App
Manifest API automation." Those phrases describe capability classes this document and
[`slack-provisioning-decision.md`](./slack-provisioning-decision.md) explicitly deferred out of
MVP scope (see §1 above and that record's "Explicitly out of scope for MVP" list): automated
OAuth code exchange needs public callback routing, Slack `client_id`/`client_secret` storage, and
a host-supported secret-*creation* API (`ctx.secrets` here exposes only `.resolve()`); this
plugin's manifest declares no inbound HTTP route today, so there is no callback endpoint to
receive a code against in the first place. The App Manifest API (`apps.manifest.*`) bulk-creation
path needs a rotating 12-hour configuration token that is not modeled anywhere in this codebase.
Per this design record's own framing — "this document...is still the input for that follow-on
work" — the authoritative contract is what ships here: manifest JSON generation plus a
single `state`-bound, single-use, expiring operator-paste-back flow (`create` → `get` →
`save`), not an in-house OAuth callback or Manifest-API automation. A future issue that lands
public inbound routing, secret-*creation*, and config-token storage is the correct place to build
the deferred flows described in §1/§7 and in `slack-provisioning-decision.md`'s "OAuth v2 install
flow (for reference / future automation)" section — this slice does not attempt them.

**Operator-facing UI is explicitly deferred, not included in this slice.** `src/ui/SettingsPage.tsx`
today only wires GitHub's manifest actions; it does not yet call `create-slack-app-manifest`,
`get-slack-app-manifest-flow`, or `save-slack-install-metadata`, and `slackProvider.definition.status`
stays `"coming-soon"` so the Slack identity option stays hidden from the settings UI (§7 of this
document describes the target UI shape, not what has shipped). Consequently this PR does not give
operators an end-to-end path to create/install a Slack app from the UI yet, and does not fully
satisfy DRO-971 / issue #58's acceptance criteria on its own — it lands the worker-side actions
those criteria depend on. A follow-up child issue should wire the settings-UI flow (manifest
display + copy/paste-back form) on top of these actions, mirroring the existing GitHub UI pattern.


**Scope note — settings-UI wiring is a separate follow-up.** This slice lands the three worker
actions above with full test coverage, but does **not** wire them into `src/ui/SettingsPage.tsx`.
`slackProvider.definition.status` therefore correctly stays `"coming-soon"` and Slack stays hidden
in the operator-facing settings UI — the same as before this PR. Landing that UI (a create/paste
manifest step, a paste-back form for `state`/`teamId`/`appId`/`botUserId`/`botTokenSecretId`, and
clear success/error status, mirroring the GitHub manifest flow already wired in
`SettingsPage.tsx`) is tracked as a separate follow-up issue so it can go through its own
TDD/review cycle rather than being bundled into this action-layer slice.
