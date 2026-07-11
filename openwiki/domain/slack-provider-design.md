# Slack provider: MVP contract and threat model

Status: design record (DRO-966). Translates the Slack research (DRO-995/DRO-996)
into a concrete `IdentityProvider` shape so implementation issues (DRO-967
through DRO-1008) have one source of truth to build against. No code changes
land with this document; it defines the target contract, not an implementation.

This is a design decision record, not implementation — treat it the same way
the GitHub provider's `README.md#adding-a-provider` section treats an
already-built provider: the reference other agents implement against.

## 1. Product boundary

Slack is a second runtime `IdentityProvider` registered once in
`src/providers/index.ts`'s `ALL_PROVIDERS` array, exactly like GitHub. Tool
execution, action registration, and manifest composition already consume that
registry generically, so `src/manifest.ts` needs no Slack-specific branch.

Settings persistence is a separate boundary and is not generic today.
`src/worker.ts`'s `normalizeIdentityInput` hard-rejects non-GitHub identities,
its save log dereferences `identity.github`, the persistence union in
`src/core/identity-config.ts` enumerates provider variants, and the settings UI
owns GitHub-specific form and environment-projection behavior. Slack delivery
therefore includes a settings-adapter dispatch table keyed by provider ID:
GitHub's current normalization moves into `normalizeGitHubSettingsInput`, Slack
implements `normalizeSlackSettingsInput`, and the worker calls the selected
adapter to obtain the persisted identity plus normalized sidecar credential.
The worker's save log becomes provider-neutral instead of dereferencing
`identity.github`. The same change adds a Slack variant to the persisted
identity union and sidecar schema, while the UI adds the matching Slack
form/projection. This is required implementation work, not a claim that the
current save path can accept Slack unchanged.

**In scope for MVP:**
- One Slack app identity per Paperclip agent (`${agentId}:slack`), mirroring
  the GitHub `${agentId}:github` identity key.
- Bot-token-based posting: send a message, reply in a thread, add/remove a
  reaction — the Slack analogues of GitHub's whoami / create-PR / push-branch
  trio.
- An identity self-check tool (`slack_bot_whoami`) that calls `auth.test` and
  returns team/user/bot identity metadata without ever returning the token.
- Settings-UI-assisted app creation via Slack's documented [app
  manifest](https://api.slack.com/reference/manifests) flow: copy the generated
  JSON, choose **From an app manifest** in Slack, and paste it for review.
- Operator-driven installation into one Slack workspace, followed by manual
  creation of a Paperclip company secret containing the bot token and entry of
  that secret's UUID in the settings form.

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
- Interactive components (buttons, modals, Block Kit forms) and arbitrary
  Block Kit/attachment payloads. MVP message tools accept plain text only; a
  later contract can add a validated static-block schema without changing the
  five tool names.
- Automated OAuth code exchange. It requires public callback routing, Slack
  client-ID/client-secret storage, single-use CSRF `state`, and a supported
  host API for creating Paperclip secrets; none exists in the current plugin
  contract. Section 7 defines the operator-driven MVP and the prerequisites
  for a later automated flow.
- Slack token rotation. MVP leaves token rotation disabled and stores a
  long-lived bot token. Refresh-token storage and renewal are deferred with
  automated OAuth.

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
  defaultChannelId: z.string().trim().regex(/^[CG][A-Z0-9]{8,}$/).optional()
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
the identity config itself. The token value lives in a Paperclip company
secret; the operator-local sidecar stores only its UUID. Slack implementation
must add an optional `slack` member to the existing sidecar identity object and
extend its refinement so `slack` alone is a valid credential source:

Operator-local sidecar, default
`/paperclip/.paperclip/agent-identities/credentials.json`:

```json
{
  "version": 1,
  "identities": {
    "<agent-id>:slack": {
      "slack": {
        "botTokenSecretId": "<paperclip-company-secret-uuid-containing-xoxb-token>"
      }
    }
  }
}
```

The exact target schema change is:

```ts
const slackCredentialSchema = z.object({
  botTokenSecretId: z.string().trim().uuid(),
  signingSecretId: z.string().trim().uuid().optional()
});

const sidecarIdentitySchema = z.object({
  secretId: z.string().trim().uuid().optional(),
  tokenFile: z.string().trim().min(1).optional(),
  githubApp: githubAppCredentialSchema.optional(),
  slack: slackCredentialSchema.optional()
}).refine(
  (value) => Boolean(
    value.githubApp || value.secretId || value.tokenFile || value.slack
  ),
  { message: "Expected githubApp, secretId, tokenFile, or slack" }
);
```

- `botTokenSecretId`: Paperclip secret reference resolved by `ctx.secrets.resolve`
  just-in-time in `resolveCredential`, exactly like `resolveGitHubCredential`
  resolves the GitHub App private key or fallback token. The bot token
  (`xoxb-...`) copied after the operator installs the app is the credential a
  tool call needs. Because MVP explicitly leaves Slack token rotation disabled,
  it is a long-lived bearer token rather than a short-lived GitHub App-style
  installation token; that changes the threat model in §9.
- `signingSecretId`: optional and omitted from every MVP save/install path. It
  is reserved only for future ingress (DRO-1005), which will need it to verify
  inbound Slack request signatures. Adding it later to an existing sidecar is
  therefore backward-compatible.

No `privateKeyFile`-style on-disk fallback for Slack. The operator copies the
installed app's bot token directly into the host's company-secret UI, then
pastes only the resulting UUID into this plugin's settings form. The plugin
SDK currently exposes `ctx.secrets.resolve` and the `secrets.read-ref`
capability, not secret creation, so neither the worker nor the UI claims to
persist the raw token. If a file fallback is ever added, it must use the same
`0600` owner-only convention and remain a documented recovery path rather
than the default.

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
  readonly messageTs: string;   // exact target message timestamp
}
```

Per the mandatory pipeline order (validate params -> resolve identity ->
resolve resource ref -> resolve credentials -> perform -> redact), the
resource-ref resolver runs **before** credential resolution and must:

1. Reject malformed channel IDs, wildcard/`*`/empty targets, and malformed
   Slack message timestamps. At this stage "resolution" is syntactic
   normalization only; authenticated Slack channel lookup is impossible
   because the token has deliberately not been resolved yet.
2. Never claim that this pre-credential step proves channel existence,
   membership, or authorization. The credentialed Slack API call in `perform`
   enforces workspace scopes and channel membership and must fail closed on
   `channel_not_found`, `not_in_channel`, or equivalent ACL errors.
3. Use `messageTs` as the neutral exact-message timestamp. The reply tool maps
   it to `thread_ts` as the parent to reply under; reaction tools pass it as
   the exact `timestamp`, which permits reacting to either a root message or a
   thread reply.

## 5. Credentials: what resolveCredential returns

```ts
export async function resolveSlackCredential(
  input: CredentialResolverInput<SlackAgentIdentity>
): Promise<ResolvedCredential> {
  const { identity, ctx } = input;
  const sidecarIdentity = await readSlackSidecarIdentity(identity.agentId);
  const token = await ctx.secrets.resolve(sidecarIdentity.slack.botTokenSecretId);

  const auth = await callSlackAuthTest(ctx, token);
  if (
    !auth.ok ||
    auth.team_id !== identity.identity.teamId ||
    auth.user_id !== identity.identity.botUserId ||
    !auth.bot_id
  ) {
    throw new Error("Slack credential does not match the configured workspace bot identity.");
  }

  return { token, secrets: [token] };
}
```

`readSlackSidecarIdentity` reads and parses the versioned sidecar, looks up
`identities[getIdentityKey(identity.agentId, "slack")]`, and fails closed if
the entry or its `slack` member is absent. `botTokenSecretId` is intentionally
not a field on the public `SlackAgentIdentity` payload. `callSlackAuthTest`
POSTs to `auth.test` with the resolved bearer token, parses only the documented
`ok`, `team_id`, `user_id`, and `bot_id` fields, and never includes the token or
raw response in an error. The `bot_id` check is mandatory and not redundant
with `team_id`/`user_id`: Slack's `auth.test` returns `bot_id` only for bot
tokens, and a user OAuth token can be configured with `teamId`/`botUserId`
values that coincidentally match a real user in the target workspace. Requiring
`bot_id` to be present rejects any credential that authenticates as a human
user, closing that path even when the other two fields line up. A stale,
mistyped, or swapped secret UUID, or a user token substituted for the bot
token, therefore fails credential resolution before any requested Slack
mutation can run.

This follows `resolveGitHubCredential`'s sidecar -> just-in-time secret ->
`{ token, secrets: [token] }` structure so the pipeline's redact step (step 6)
can strip `token` from whatever `perform` returns. Slack adds the mandatory
`auth.test` binding check above and has no token-minting step. GitHub mints a
short-lived installation token per call from a durable private key; MVP's Slack
bot token is itself the durable secret. Slack offers optional token rotation,
but supporting it would require refresh-token storage and renewal and is
explicitly deferred. That asymmetry is the primary input to the threat model
in §9.

## 6. Tools (MVP)

| Tool | `requiresCredential` | Resource ref | Slack API calls |
| --- | --- | --- | --- |
| `slack_bot_whoami` | `true` | none | resolver: `auth.test`; result reused |
| `slack_bot_post_message` | `true` | `SlackChannelRef` | resolver: `auth.test`; perform: `chat.postMessage` |
| `slack_bot_post_reply` | `true` | `SlackMessageRef` | resolver: `auth.test`; perform: `chat.postMessage` with `thread_ts` |
| `slack_bot_add_reaction` | `true` | `SlackMessageRef` | resolver: `auth.test`; perform: `reactions.add` |
| `slack_bot_remove_reaction` | `true` | `SlackMessageRef` | resolver: `auth.test`; perform: `reactions.remove` |

`slack_bot_remove_reaction` is bounded by a real Slack API limitation, not just
a Paperclip policy choice: `reactions.remove` only removes a reaction
previously added by the calling bot's own identity. It cannot remove a
reaction that a different user or bot added to the same message. The tool
contract and its user-facing description must state this ownership limit
explicitly so implementers and tool consumers do not treat it as unrestricted
reaction removal; a request to remove another identity's reaction fails
closed with Slack's `no_reaction`/permission error rather than silently
succeeding or removing the wrong reaction.

`slack_bot_whoami` is intentionally credentialed even though GitHub's local
whoami is not: Slack `auth.test` requires the bot token and verifies the live
installation rather than merely echoing configured metadata. A missing or
unresolvable secret therefore fails in the shared credential step before the
tool result. The resolver's required `auth.test` binding check is the whoami
tool's live verification; after it succeeds, `perform` returns the verified
`teamId`/`botUserId` plus configured `label`/`appId` without making a duplicate
API call. Slack's `auth.test` does not return `appId`, so the tool must not claim
that field was independently verified.

`manifestTools` (the manifest-facing fragments consumed by the composed
manifest, see `src/providers/github/manifest-tools.ts` for the pattern)
declares these five tools' Paperclip-facing metadata — names, descriptions,
param schemas — with no Slack-specific code in `src/manifest.ts` itself.

### 6.1 Exact parameter and result contract

All parameter objects reject unknown fields. In particular, no tool accepts an
`agentId`, token, raw Slack response, `blocks`, or `attachments` field. These
are the literal JSON Schema objects assigned to each manifest tool's
`parametersSchema`:

```ts
const channelIdProperty = {
  type: "string",
  pattern: "^[CG][A-Z0-9]{8,}$"
} as const;
const textProperty = {
  type: "string",
  minLength: 1,
  maxLength: 40_000,
  pattern: "\\S"
} as const;
const messageTsProperty = {
  type: "string",
  pattern: "^[0-9]{10,}\\.[0-9]{6}$"
} as const;
const reactionProperty = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: "^[a-z0-9_+-]+$"
} as const;

const slackWhoamiParametersSchema = {
  type: "object",
  properties: {},
  additionalProperties: false
} as const;

const slackPostMessageParametersSchema = {
  type: "object",
  properties: { channelId: channelIdProperty, text: textProperty },
  required: ["text"],
  additionalProperties: false
} as const;

const slackPostReplyParametersSchema = {
  type: "object",
  properties: {
    channelId: channelIdProperty,
    messageTs: messageTsProperty,
    text: textProperty
  },
  required: ["messageTs", "text"],
  additionalProperties: false
} as const;

const slackReactionParametersSchema = {
  type: "object",
  properties: {
    channelId: channelIdProperty,
    messageTs: messageTsProperty,
    reaction: reactionProperty
  },
  required: ["messageTs", "reaction"],
  additionalProperties: false
} as const;
```

`slack_bot_whoami` uses `slackWhoamiParametersSchema`;
`slack_bot_post_message` uses `slackPostMessageParametersSchema`;
`slack_bot_post_reply` uses `slackPostReplyParametersSchema`; and both reaction
tools use `slackReactionParametersSchema`.

- `channelId` is optional in all four channel-targeting tools. An explicit
  value wins; otherwise `identity.defaultChannelId` is used. Resource
  resolution fails closed if neither exists. The resolved value must match
  `^[CG][A-Z0-9]{8,}$`. `C...` identifies a channel; Slack also uses `G...`
  for both private channels and multi-person conversations, which cannot be
  distinguished syntactically without the deliberately omitted read scopes.
  MVP therefore permits either kind of accessible `G...` conversation and
  relies on Slack membership ACLs; one-to-one `D...` targets are rejected.
- `text` is required, must contain at least one non-whitespace character, and
  is limited to 40,000 characters. The original text is sent unchanged after
  validation.
- `messageTs` must match `^[0-9]{10,}\.[0-9]{6}$`. For
  `slack_bot_post_reply` it is the parent message passed as `thread_ts`; for
  reaction tools it is the exact message passed as `timestamp`.
- `reaction` is the emoji name without surrounding colons, 1-100 characters,
  and must match `^[a-z0-9_+-]+$`.

Successful results follow the repository's existing `{ content, data }` tool
shape rather than returning Slack response bodies:

```ts
type SlackWhoamiResult = {
  content: string;
  data: {
    label: string;
    teamId: string;
    botUserId: string;
    appId: string;
  };
};

type SlackPostMessageResult = {
  content: string;
  data: {
    channelId: string;
    messageTs: string;
  };
};

type SlackPostReplyResult = {
  content: string;
  data: {
    channelId: string;
    parentMessageTs: string;
    replyMessageTs: string;
  };
};

type SlackReactionResult = {
  content: string;
  data: {
    channelId: string;
    messageTs: string;
    reaction: string;
    action: "added" | "removed";
  };
};
```

Every validation, credential, ACL, or Slack API failure uses the pipeline's
existing `{ error: string }` shape. Errors may include Slack's stable error
code (for example `channel_not_found`) but never the token or a raw response.
The add/remove tools share `slackReactionParametersSchema` and
`SlackReactionResult`; the registered tool name fixes the result's `action`
value.

## 7. Actions: app manifest + operator-driven install flow

Slack's documented copy/paste app-manifest flow fills the same setup role as
GitHub's App Manifest flow (`contributeGitHubAppManifestActions` /
`src/providers/github/app-manifest.ts`), but it is deliberately operator-driven:

1. Settings page builds a Slack app manifest JSON with the minimum bot scopes
   `chat:write` and `reactions:write`, copies it to the clipboard, and opens
   `https://api.slack.com/apps` in a separate tab. Neither resource resolution
   nor the MVP UI performs channel discovery, so `channels:read` and
   `groups:read` are intentionally omitted. `chat:write.public` is also omitted,
   so the app must be a member of every public or private target channel.
2. Operator chooses **Create New App** -> **From an app manifest**, selects the
   intended workspace, pastes the generated JSON, reviews it, and confirms app
   creation. This documented paste step is required; the MVP does not depend on
   an undocumented `manifest_json` dashboard query parameter.
3. Operator uses Slack's app-management UI to install the app to the intended
   workspace, then copies the Bot User OAuth Token shown by Slack.
4. Operator creates a Paperclip company secret through the host UI, stores the
   bot token there, and copies the resulting secret UUID. The plugin never
   receives the raw token through its settings action.
5. Operator enters `teamId`, `botUserId`, `appId`, and `botTokenSecretId` in
   the Slack identity form. Saving dispatches through the provider-owned
   persistence normalizer described in §1, writes the public identity variant
   to settings state, and writes the UUID under the Slack sidecar entry.

The copy/paste UI flow uses no Slack configuration token, so the 12-hour
configuration-token expiry does not apply to this MVP. A future automation
that calls `apps.manifest.create`/`apps.manifest.update` must handle that expiry
explicitly.

Automated OAuth is deferred. Before it can replace steps 3-5, the host and
plugin must provide: a public callback URL, secure `client_id` and
`client_secret` storage/retrieval for `oauth.v2.access`, redirect-URI matching,
cryptographically random single-use `state`, and a host-supported secret-write
API. The current SDK offers secret resolution only; documenting a code exchange
without those prerequisites would describe an unimplementable flow.

## 8. UI contribution

Settings page adds a Slack identity form beside the GitHub form. This requires
extending the UI's provider-discriminated form model; the runtime provider
registry does not currently generate settings forms. Minimum fields are team
ID, app ID, bot-user ID, bot-token secret UUID, and optional default channel,
plus separate **Copy App Manifest** and **Open Slack App Dashboard** actions and
operator instructions for the documented paste, installation, and host secret
creation steps. The form submits the Slack variant to the provider-owned
persistence normalizer from §1. It must never accept or render the raw `xoxb-`
token, and it does not collect `signingSecretId` in MVP.

## 9. Threat model

Threats are framed against the same pipeline invariant every provider tool
must uphold: validate params -> resolve identity -> resolve resource ref ->
resolve credentials -> perform -> redact. Each threat below names which step
is the control point.

### T1 — Long-lived bot token compromise (MVP rotation decision)
**Risk:** Slack supports optional token rotation, but MVP deliberately leaves
it disabled because the current credential model has no refresh-token storage
or renewal path. Unlike GitHub's short-lived installation tokens, an MVP bot
token therefore remains valid until revoked or manually rotated.
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
target. Credential resolution then calls `auth.test` and requires its `team_id`
and `user_id` to match the resolved identity's `teamId` and `botUserId`, and
requires `bot_id` to be present so a user-token credential can never satisfy
the check; a sidecar entry pointing at another agent's token, or at a user
token, fails before `perform`.
Contract tests must cover "agent A cannot resolve agent B's identity", "agent
A's sidecar cannot substitute agent B's valid token", and "a user OAuth token
whose team_id/user_id happen to match is rejected for missing bot_id" cases.

### T3 — Channel/target injection past the resource-ref boundary
**Risk:** an agent (or a prompt-injected instruction reaching the agent)
supplies an attacker-chosen channel ID or thread timestamp to post
misleading, exfiltrating, or spammy content into a channel the operator did
not intend the bot to reach.
**Mitigation:** step 3 (resolve resource ref) runs before any credential is
touched — this is the pipeline's designed choke point for exactly this
threat. `resolveResourceRef` for `slack_bot_post_message` must validate the
conversation ID shape and, per §4 point 2, treat "the app must be a member of
every target conversation" as the enforced authorization boundary — Slack's
own ACL, not a plugin-side allowlist that could drift out of sync with actual
scopes. For MVP, do **not** add a plugin-side channel allowlist config (extra
surface, extra drift risk); rely on Slack's membership model exactly as GitHub
reliance rests on App installation scope, and document this explicitly so a
future operator does not assume the plugin enforces a channel allowlist it
does not.

### T4 — Future OAuth callback hijack
**Risk:** automated OAuth is out of MVP scope, but a later web-facing callback
could bind a forged or replayed authorization code to the wrong agent.
**Mitigation (future acceptance criterion):** generate a cryptographically
random, single-use Slack OAuth `state` tied to the settings session and target
agent; verify it before any code exchange. Store client credentials outside
plugin state and require an exact registered redirect URI. The operator-driven
MVP has no callback endpoint and therefore does not expose this attack surface.

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
only the normalized `{ content, data }` fields in §6.1, and the pipeline's
redact step scrubs `token` from that return value regardless. Reactions include
both add and remove paths. Tests should assert no test
fixture ever contains a real-shaped Slack token pattern (`xoxb-`, `xoxp-`)
being written to a comment, log, or committed file — same discipline as
existing credential tests for GitHub App keys.

## 10. Implementation notes and deferred questions

- `defaultChannelId` receives syntax-only validation at save time and remains
  unverified until first tool use. A future live channel picker/discovery flow
  must justify and document any additional read scopes before adding them.
- Rate limiting: `chat.postMessage` is a special-tier method allowing roughly
  one message per second per channel, with additional workspace-wide limits.
  Implement throttling per channel, honor `Retry-After`, and retain a
  workspace-wide backstop rather than serializing all channels through one
  one-request-per-second queue. Track the concrete scheduler as follow-up work
  if agents are expected to post at volume.
- Multi-workspace support (§1, explicitly deferred) will need a
  `teamId`-qualified identity key (`${agentId}:slack:${teamId}`) if it is
  ever added; flagging now so the identity-key format decision is made
  deliberately rather than as an afterthought migration.
