# Slack provider: MVP contract and threat model

Status: design record (DRO-966). Translates the Slack research (DRO-995/DRO-996)
into a concrete `IdentityProvider` shape so implementation issues (DRO-967
through DRO-1008) have one source of truth to build against. No code changes
land with this document; it defines the target contract, not an implementation.

This is a design decision record, not implementation — treat it the same way
the GitHub provider's `README.md#adding-a-provider` section treats an
already-built provider: the reference other agents implement against.

## 1. Product boundary

Slack is a second `IdentityProvider` registered once in
`src/providers/index.ts`'s `ALL_PROVIDERS` array, exactly like GitHub. Nothing
in `src/worker.ts` or `src/manifest.ts` becomes Slack-aware; both already
consume the registry generically.

**In scope for MVP:**
- One Slack app identity per Paperclip agent (`${agentId}:slack`), mirroring
  the GitHub `${agentId}:github` identity key.
- Bot-token-based posting: send a message, reply in a thread, add/remove a
  reaction — the Slack analogues of GitHub's whoami / create-PR / push-branch
  trio.
- An identity self-check tool (`slack_bot_whoami`) that calls `auth.test` and
  returns team/user/bot identity metadata without ever returning the token.
- Settings-UI-driven app creation via Slack's [app manifest](https://api.slack.com/reference/manifests)
  deep link (`https://api.slack.com/apps?new_app=1&manifest_json=...`),
  mirroring the GitHub App Manifest bootstrap flow.
- OAuth installation (`oauth.v2.access`) to obtain a bot token scoped to a
  single workspace installation, analogous to GitHub App installation.

**Explicitly out of scope for MVP** (tracked as later work, not silently
dropped):
- Slack Events API / Socket Mode ingress (listening for messages, mentions,
  slash commands). DRO-1005 scopes ingress separately; this record only
  defines outbound tool calls and the identity/credential shape ingress will
  reuse.
- Multi-workspace fan-out for a single agent identity (one Slack app
  installed into N workspaces). MVP is one workspace installation per agent
  identity, same cardinality as one GitHub App installation per agent.
- User-token (as opposed to bot-token) scopes. MVP never requests or stores
  a user token.
- Interactive components (buttons, modals, Block Kit forms) beyond posting
  Block-Kit-formatted messages as static content.

## 2. Identity shape

Following the GitHub precedent (`src/providers/github/config.ts`), the Slack
identity is a `zod` schema owned entirely by `src/providers/slack/config.ts`.
Nothing outside the provider module parses it.

```ts
// src/providers/slack/config.ts (target shape)
export const slackIdentitySchema = z.object({
  label: z.string().trim().min(1),
  teamId: z.string().trim().min(1),        // Slack workspace ID, e.g. "T0123ABCD"
  botUserId: z.string().trim().min(1),     // Slack bot user ID, e.g. "U0123ABCD"
  appId: z.string().trim().min(1),         // Slack app ID, e.g. "A0123ABCD"
  defaultChannelId: z.string().trim().min(1).optional()
});
```

Parallel to GitHub's `githubUsername`/`commitName`/`commitEmail`, Slack's
identity carries only **public, non-secret** metadata: team, bot user, and app
IDs are not credentials — they identify the installation, not authorize
anything. `defaultChannelId` is an optional UX convenience (pre-fill a "post
to" default), not an authorization boundary; the resource-ref resolver (§4)
still validates the channel on every call.

No token, signing secret, or client secret belongs in this schema — see §5.

## 3. Install metadata and credential references

Mirroring the GitHub App credential-sidecar pattern
(`src/credential-sidecar.ts`, README "GitHub App credentials"), Slack
credentials never live in Paperclip plugin state (which is not
secret-isolated across agents reading the same state blob) and never live in
the identity config itself. They live in exactly one of two places, same as
GitHub App keys:

```json
// operator-local sidecar, default /paperclip/.paperclip/agent-identities/credentials.json
{
  "<agent-id>:slack": {
    "slack": {
      "botTokenSecretId": "<paperclip-company-secret-uuid-containing-xoxb-token>",
      "signingSecretId": "<paperclip-company-secret-uuid-containing-signing-secret>"
    }
  }
}
```

- `botTokenSecretId`: Paperclip secret reference resolved by `ctx.secrets.resolve`
  just-in-time in `resolveCredential`, exactly like `resolveGitHubCredential`
  resolves the GitHub App private key or fallback token. The bot token
  (`xoxb-...`) from `oauth.v2.access` is the credential a tool call needs; it
  is a long-lived bearer token (Slack bot tokens do not expire the way GitHub
  App installation tokens do), which changes the threat model in §6.
- `signingSecretId`: only needed once ingress (DRO-1005, out of scope here)
  verifies inbound Slack request signatures. Recorded now so the sidecar shape
  does not need a breaking migration when ingress lands.

No `privateKeyFile`-style on-disk fallback for Slack: unlike a GitHub App
private key (which must be written to disk once, at manifest-conversion time,
because GitHub returns raw PEM content), Slack's OAuth exchange returns a
token directly to the settings-page worker action, which should write it
straight into a Paperclip secret. If a file-based fallback is ever added for
parity with GitHub, it must go through the same `0600`-owner-only file
convention and be documented as a fallback, not the default.

## 4. Resource references

GitHub's `TRef` varies per tool (`GitHubRepoRef` for create-PR,
`GitHubPushTarget` for push-branch) but all extend the shared
`ResourceReference` (`{ kind: string }`) so the pipeline can validate
type-generically. Slack resource refs follow the same shape:

```ts
export interface SlackChannelRef extends ResourceReference {
  readonly kind: "slack-channel";
  readonly channelId: string;   // resolved, not the raw param — see below
}

export interface SlackMessageRef extends ResourceReference {
  readonly kind: "slack-message";
  readonly channelId: string;
  readonly threadTs: string;    // parent message timestamp for a threaded reply
}
```

Per the mandatory pipeline order (validate params -> resolve identity ->
resolve resource ref -> resolve credentials -> perform -> redact), the
resource-ref resolver runs **before** credential resolution and must:

1. Reject channel identifiers that are not resolvable to a real, distinct
   Slack channel ID (no wildcard/`*`/empty-string channel targets).
2. Refuse to resolve a channel the calling agent's identity has no
   installation-scoped reason to post to. MVP's authorization boundary is
   the Slack app's OAuth scopes and per-channel invite state (an app must be
   invited to a private channel to post there) — same "provider permissions
   decide access, not this plugin" posture the README states for GitHub
   repos. The resolver's job is param hygiene and fail-closed denial on
   malformed/missing refs, not re-implementing Slack's ACL.
3. Never accept a bare, unvalidated string as the final `channelId`/`threadTs`
   without going through this resolver — this is what makes step 3 sit before
   step 4 in the pipeline: a bad target must be denied before a token is ever
   touched.

## 5. Credentials: what resolveCredential returns

```ts
export async function resolveSlackCredential(
  input: CredentialResolverInput<SlackAgentIdentity>
): Promise<ResolvedCredential> {
  const { identity, ctx } = input;
  const token = await ctx.secrets.resolve(identity.botTokenSecretId);
  return { token, secrets: [token] };
}
```

This mirrors `resolveGitHubCredential` exactly: resolve just-in-time, return
`{ token, secrets: [token] }` so the pipeline's redact step (step 6) can strip
`token` from whatever `perform` returns. The one structural difference from
GitHub: there is no minting step. GitHub mints a short-lived installation
token per call from a durable private key; Slack's bot token from
`oauth.v2.access` **is** the durable secret — there is no rotation-on-every-call
primitive in Slack's bot-token model. That asymmetry is the primary input to
the threat model in §6.

## 6. Tools (MVP)

| Tool | `requiresCredential` | Resource ref | Slack API |
| --- | --- | --- | --- |
| `slack_bot_whoami` | `false` | none | `auth.test` |
| `slack_bot_post_message` | `true` | `SlackChannelRef` | `chat.postMessage` |
| `slack_bot_post_reply` | `true` | `SlackMessageRef` | `chat.postMessage` (with `thread_ts`) |
| `slack_bot_add_reaction` | `true` | `SlackMessageRef` | `reactions.add` |

`slack_bot_whoami` follows the GitHub `githubWhoamiToolSpec` precedent
exactly: `requiresCredential: false`, so the pipeline skips credential
resolution and the tool provably never touches a secret — identity checks
answer "who am I posting as" without minting anything. It should call
`auth.test` with a token if one is configured for diagnostics, but the
provider contract's `requiresCredential: false` path means it must work (or
fail closed with a clear "no identity configured" message) even before any
credential exists.

`manifestTools` (the manifest-facing fragments consumed by the composed
manifest, see `src/providers/github/manifest-tools.ts` for the pattern)
declares these four tools' Paperclip-facing metadata — names, descriptions,
param schemas — with no Slack-specific code in `src/manifest.ts` itself.

## 7. Actions: app manifest + OAuth install flow

Slack's app manifest deep link plays the same settings-page role as GitHub's
App Manifest flow (`contributeGitHubAppManifestActions` /
`src/providers/github/app-manifest.ts`):

1. Settings page builds a Slack app manifest JSON (bot scopes:
   `chat:write`, `reactions:write`, `channels:read` at minimum for MVP's
   tool set; no `channels:history`/`groups:history`/message-content scopes
   until ingress, DRO-1005, needs them) and opens
   `https://api.slack.com/apps?new_app=1&manifest_json=<url-encoded-manifest>`.
2. Operator reviews and confirms app creation in Slack's UI (Slack, unlike
   GitHub's manifest flow, does not silently auto-create — this is a required
   manual step, not an optional review; the settings UI copy must say so).
3. Operator (or the app's own "Install to Workspace" button) drives OAuth
   installation; Slack redirects back to a plugin `setup_url`-equivalent
   worker action with a `code` param.
4. Worker action exchanges `code` via `oauth.v2.access`, receives
   `access_token` (bot token), `team.id`, `bot_user_id`, `app_id`. It writes
   the bot token straight to a Paperclip secret (never to a file, see §3),
   and returns the public fields (`teamId`, `botUserId`, `appId`) to prefill
   the identity form — exactly the "prefill App ID / Installation ID" UX
   GitHub's flow already has.
5. Saving the identity patches the sidecar credential reference and (if
   Slack tooling needs an env-var-visible ID for parity with
   `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`) writes non-secret `SLACK_TEAM_ID`/
   `SLACK_APP_ID` into the selected agent's environment — never the bot token
   itself as a raw env var; the token stays in the secret store and is
   resolved just-in-time by `resolveSlackCredential`.

Slack app manifests are also subject to a documented **12-hour configuration
token expiry** on the App Manifest APIs (per DRO-995's research scope) — the
settings-page flow must treat manifest-token expiry as an expected failure
mode with a clear "restart app creation" recovery path, not an unhandled
error.

## 8. UI contribution

Settings page adds a Slack identity form beside the GitHub form (both driven
by the same provider-registry-backed identity list — no `if (provider ===
"slack")` branch in `SettingsPage.tsx` logic beyond what already
differentiates per-provider field sets, matching how GitHub's fields are
already isolated from a generic identity list). Minimum fields: team,
app, and bot-user read-only display (post-install), a "Create Slack App"
button (manifest deep link), an "Install to Workspace" button/link
(post-manifest-creation), and a default-channel picker (optional, §2).

## 9. Threat model

Threats are framed against the same pipeline invariant every provider tool
must uphold: validate params -> resolve identity -> resolve resource ref ->
resolve credentials -> perform -> redact. Each threat below names which step
is the control point.

### T1 — Long-lived bot token compromise (no just-in-time minting)
**Risk:** unlike GitHub's short-lived installation tokens, a compromised
Slack bot token is valid until manually rotated — there is no automatic
expiry to bound blast radius.
**Mitigation:** treat the bot token as the single most sensitive artifact in
the Slack credential path. Store only as a Paperclip secret reference
(`botTokenSecretId`), resolved just-in-time in step 4, never persisted to a
file or written into `ctx` state. Recommend workspace admins scope the app to
the minimum bot scopes in §7 and rotate on any suspected leak; this plugin
cannot force Slack-side rotation, but it can guarantee the token never
appears in agent config, workspace files, tool output, or logs (redact step
6, plus a hard rule: `perform` must not `console.log`/return raw response
bodies that could embed the token).

### T2 — Cross-agent identity confusion
**Risk:** because agent identities are keyed by `${agentId}:slack`, a bug
that resolves the wrong agent's identity would let agent A post as agent B's
Slack bot identity — the Slack analogue of DRO-830's GitHub credential
cross-read.
**Mitigation:** identity resolution (step 2) is a hard boundary already
enforced by the shared `resolveAgentIdentityFromToolRunContext`-equivalent
lookup keyed strictly by the calling `runCtx.agentId`. Slack's provider
module must not accept an `agentId` param from tool input to select an
identity — the identity is always the caller's own, never a caller-supplied
target. Contract tests should include an explicit "agent A cannot resolve
agent B's Slack identity even if it supplies B's agentId in tool params" case,
mirroring the credential-isolation intent of the GitHub work.

### T3 — Channel/target injection past the resource-ref boundary
**Risk:** an agent (or a prompt-injected instruction reaching the agent)
supplies an attacker-chosen channel ID or thread timestamp to post
misleading, exfiltrating, or spammy content into a channel the operator did
not intend the bot to reach.
**Mitigation:** step 3 (resolve resource ref) runs before any credential is
touched — this is the pipeline's designed choke point for exactly this
threat. `resolveResourceRef` for `slack_bot_post_message` must validate the
channel ID shape and, per §4 point 2, treat "the app has to be invited to a
private channel" as the enforced authorization boundary — Slack's own ACL,
not a plugin-side allowlist that could drift out of sync with actual scopes.
For MVP, do **not** add a plugin-side channel allowlist config (extra
surface, extra drift risk); rely on Slack's channel-membership model exactly
as GitHub reliance rests on App installation scope, and document this
explicitly so a future operator does not assume the plugin enforces a
channel allowlist it does not.

### T4 — Manifest/OAuth callback hijack
**Risk:** the settings-page OAuth callback (`code` exchange, §7 step 4) is a
web-facing endpoint; a forged callback or replayed `code` could bind a
different Slack app's token to an agent's identity.
**Mitigation:** reuse Slack's `state` parameter in the OAuth authorize URL
(cryptographically random, single-use, tied to the settings-page session)
exactly as CSRF protection is expected in any OAuth 2 code-exchange flow;
verify `state` before completing token exchange. This is new work relative
to GitHub's App Manifest flow (which uses a one-time code without an
explicit `state` requirement because it never traverses a public OAuth
redirect) and should be a named acceptance criterion on the OAuth-install
implementation issue, not assumed to fall out of "copy the GitHub flow."

### T5 — Signing-secret / ingress abuse (deferred but shape-relevant)
**Risk:** out of MVP scope (§1), but the sidecar shape in §3 already reserves
`signingSecretId`. If ingress is implemented before this threat is
reconsidered, an attacker who can reach the ingress endpoint without a valid
Slack signature could spoof events as if from Slack.
**Mitigation (forward-looking, not implemented here):** ingress (DRO-1005)
must verify the `X-Slack-Signature`/`X-Slack-Request-Timestamp` headers
against `signingSecretId` before trusting any event body, and must reject
requests outside Slack's replay window (roughly 5 minutes). This record only
flags the requirement so DRO-1005 does not have to re-derive it.

### T6 — Secret leakage through tool output or manifest-flow logs
**Risk:** same class of risk the project constraints already name explicitly
("never place Slack config tokens... in agent config, workspaces, tool
output, issue comments, logs, or git").
**Mitigation:** enforced structurally, not just by policy: `perform` returns
only what `chat.postMessage`/`reactions.add`/`auth.test` need to report
(message ts, channel id, ok/error) and the pipeline's redact step scrubs
`token` from that return value regardless. Tests should assert no test
fixture ever contains a real-shaped Slack token pattern (`xoxb-`, `xoxp-`)
being written to a comment, log, or committed file — same discipline as
existing credential tests for GitHub App keys.

## 10. Open questions for implementation issues

- Should `defaultChannelId` be validated against the live channel list at
  save time (extra Slack API call from the settings page) or left
  unvalidated until first tool use? Recommend the latter for MVP — avoids a
  settings-page dependency on a valid token merely to edit the field.
- Rate limiting: Slack's tiered rate limits (`chat.postMessage` is Tier 3,
  roughly 1/sec sustained per workspace) are not addressed in this record.
  Recommend a follow-up issue if agents are expected to post at volume.
- Multi-workspace support (§1, explicitly deferred) will need a
  `teamId`-qualified identity key (`${agentId}:slack:${teamId}`) if it is
  ever added; flagging now so the identity-key format decision is made
  deliberately rather than as an afterthought migration.
