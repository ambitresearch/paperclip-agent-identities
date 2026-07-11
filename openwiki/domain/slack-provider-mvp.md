# Slack provider MVP — contract, product boundary, threat model

Status: **architecture decision (design)**, no provider code exists yet. This document
translates the research in [`slack-provisioning-decision.md`](./slack-provisioning-decision.md)
(pending merge in PR #66) into the concrete `IdentityProvider` contract this repo already
enforces (see `agent-identities.md` and `/src/core/provider-contract.ts`). It is the input for a
future `feat(providers): add Slack identity provider` implementation task; it does not itself add
a provider.

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
  GitHub PEM is). `token_rotation_enabled: true` in the manifest (see the canonical template in
  the decision record) means the sidecar must additionally track a refresh token; treat it exactly
  like the bot token — Paperclip-secret-backed, mode `0600` on any transient file, never returned
  from a tool.

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

`resolveResourceRef` (the async, pre-credential step in `ProviderToolSpec`) resolves a
caller-supplied channel name/ref to a channel ID via `channels:read`/`groups:read` *before* any
token is minted — same ordering guarantee GitHub's push/PR tools use to deny disallowed targets
before a secret exists. A caller-supplied channel that doesn't resolve, or resolves to a channel
outside an allow-list (if one is configured), is denied at this step, not after token resolution.

## 4. Tools (mapped 1:1 to minimum bot scopes from the decision record)

| Tool | `requiresCredential` | Scope | Resource ref |
| --- | --- | --- | --- |
| `slack-whoami` | `false` (identity-metadata-only, mirrors `github-whoami`) | none (`auth.test`) | none |
| `slack-post-message` | `true` | `chat:write` | `SlackChannelRef` |
| `slack-reply-thread` | `true` | `chat:write` (thread_ts param, no separate scope) | `SlackChannelRef` |
| `slack-react` | `true` | `reactions:write` | `SlackChannelRef` |
| `slack-lookup-channel` | `true` (needs a token to call `channels.list`/`conversations.info`) | `channels:read`, `groups:read` | none (this tool *produces* a ref) |

No `slack-join-channel` tool in MVP — `channels:join` is listed as optional/deferred in the
decision record; omit until a concrete need surfaces (least-privilege: don't request or wire a
scope with no consuming tool).

## 5. Manifest fragments

`manifestTools` (the `IdentityProvider.manifestTools` field) contributes the canonical manifest
template from the decision record, parameterized the same way GitHub's `manifest-tools.ts`
parameterizes its GitHub App manifest — `{{agentLabel}}` / `{{workerHost}}` filled by the
composition layer at generation time. The Slack manifest additionally needs
`settings.event_subscriptions.request_url` and `settings.interactivity.is_enabled: false`
pre-filled per the decision record's rejection of Socket Mode as default.

## 6. Actions (`contributeActions`)

Mirrors `contributeGitHubAppManifestActions`: a `create-slack-app-manifest` worker action that
builds the per-agent manifest JSON and returns the `https://api.slack.com/apps?new_app=1&manifest_json=...`
deep link (URL-encoded), and a `save-slack-install-metadata` action the settings UI calls once the
operator finishes Slack's own click-through install and pastes back `teamId`/`appId`/`botUserId`
(no OAuth code exchange in MVP — Slack's manifest deep-link flow produces the bot token via its own
UI, not a callback we handle). This is a deliberately smaller flow than GitHub's manifest
conversion, because Slack's manifest-json deep link does not have a GitHub-style
"exchange code for PEM" step; the operator relays back only shareable IDs.

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
- **Install ownership**: the operator who runs the manifest deep link and completes the Slack
  "Install to Workspace" click-through owns the resulting app at the Slack-workspace-admin level.
  Paperclip only receives back the bot token (via secret) and shareable IDs — it never becomes a
  Slack workspace admin.

## 9. Threat model

| Threat | Mitigation |
| --- | --- |
| **Credential disclosure** (bot token / signing secret / refresh token leaked via config, logs, git, tool output) | Same invariant as GitHub: `resolveCredential` mints/reads the token just-in-time from the sidecar (Paperclip-secret-backed), never persisted in `AgentIdentityConfig`, never returned by any tool `perform()`. Follows the mandatory pipeline order (validate params → resolve identity → resolve resource ref → resolve credentials → perform → redact) so a credential is only in memory for the shortest possible window. |
| **Confused-deputy posting** (agent A's tool call posts using agent B's Slack identity) | `resolveAgentIdentity()` keys strictly off `runContext.agentId` (same as GitHub) — there is no cross-agent identity parameter a tool call can supply. Because Slack identity is 1 app/bot-user per agent, there is no shared-token surface for a mixup to exploit (unlike a hypothetical shared workspace app). |
| **Forged OAuth callbacks** | MVP doesn't implement an OAuth callback at all (manifest deep-link + operator paste-back of IDs only) — this threat class is deferred until/unless an in-house OAuth install flow is built, at which point the decision record's OAuth section (state validation, exact redirect-URI match) is the mandatory implementation baseline. |
| **Replayed events** (inbound Events API POSTs replayed by an attacker) | Deferred to when inbound event handling ships (see §10) — the Events API path must * verify `X-Slack-Signature`/`X-Slack-Request-Timestamp` per the decision record's HTTP-vs-Socket-Mode section, AND reject requests with a timestamp outside a small window (Slack's own recommended ±5 min) to bound replay. |
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
