# Slack provider: MVP contract and threat model

Status: historical design decision record (DRO-966), updated with shipped
behavior annotations. This record originally translated the Slack research
(DRO-995/DRO-996) into a concrete `IdentityProvider` target for implementation
issues DRO-967 through DRO-1008. At that point no code landed with the document.

Historical design context is retained where it explains the original choices.
Current shipped behavior is called out where implementation later diverged.
Current source and tests are canonical when they differ from an original target
or pseudocode example in this record.

## 1. Product boundary

Slack is a second runtime `IdentityProvider` registered once in
`src/providers/index.ts`'s `ALL_PROVIDERS` array, exactly like GitHub. Tool
execution, action registration, and manifest composition already consume that
registry generically, so `src/manifest.ts` needs no Slack-specific branch.

Settings persistence remains a separate, provider-specific boundary. The
shipped Slack settings adapter adds the Slack form and public settings-state
projection, while `save-slack-install-metadata` owns Slack installation
persistence. That action writes the public identity fields to settings state
and calls `ctx.config.patchSecretRefs` to write the company-scoped identity at
`identities.<agentId>`, including required typed secret refs at
`credentials.botToken` and `credentials.signingSecret`. Slack credentials do
not use the local credential sidecar.

Historical design context: the initial plan called for a provider dispatch
table that returned a normalized sidecar credential and extended the GitHub
sidecar schema for Slack. That sidecar design did not ship. The company-scoped
host-config path became the Slack credential boundary once typed secret-ref
persistence was available.

**In scope for MVP:**
- One Slack app identity per Paperclip agent (`${agentId}:slack`), mirroring
  the GitHub `${agentId}:github` identity key.
- Bot-token-based posting: send a message, reply in a thread, add/remove a
  reaction — the Slack analogues of GitHub's whoami / create-PR / push-branch
  trio.
- A credential-free identity self-check tool (`slack_bot_whoami`, DRO-972)
  that mirrors GitHub's local `github_bot_whoami`: it never resolves the bot
  token and only echoes the already-validated, configured `SlackAgentIdentity`
  fields (`label`, `teamId`, `appId`, `botUserId`, `hasDefaultChannel`) — no
  `auth.test` call, no live-installation verification. (An earlier revision
  of this design specified a credentialed, `auth.test`-backed whoami; the
  implementation shipped credential-free instead, and this doc has been
  corrected to match.)
- Settings-UI-assisted app creation via Slack's documented [app
  manifest](https://api.slack.com/reference/manifests) flow: copy the generated
  JSON, choose **From an app manifest** in Slack, and paste it for review.
- Operator-driven installation into one Slack workspace, followed by manual
  creation of Paperclip company secrets for the bot token and signing secret
  and entry of both secret UUIDs in the settings form.

**Explicitly out of scope for MVP** (tracked as later work, not silently
dropped):
- Socket Mode ingress, slash commands, and interactive event families. The
  HTTP Events API receiver, direct-message `message.im` subscription, and
  mention-only public-channel `app_mention` subscription are shipped; these
  additional transports and event types remain deferred.
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

Historical scope note: the original MVP deferred all ingress. DRO-1005/PR #81
later implemented the HTTP Events API receiver selected by
[`slack-provisioning-decision.md`](./slack-provisioning-decision.md), and a
follow-up shipped manifest provisioning. The generated manifest now requires an
HTTPS URL with the exact `/events` path, writes it to
`settings.event_subscriptions.request_url`, subscribes to `message.im` and
`app_mention`, and requests `im:history` plus `app_mentions:read`. Socket Mode
remains deferred.

A top-level `app_mention` starts a Slack thread rooted at that event's `ts`.
Mentions received inside an existing thread keep their original `thread_ts`.
Top-level direct messages receive one final response in the main DM, and only
use a thread when the inbound DM already has `thread_ts`. Slack does not expose
the human composer typing indicator to bots through its official Web API. The
receiver uses `assistant.threads.setStatus` for supported assistant threads and
falls back to a temporary `:hourglass_flowing_sand:` reaction on the inbound
message when thread status is unavailable. The reaction is removed when processing
ends. It does not simulate typing by posting and later editing a placeholder message.
This processing indicator is deterministic receiver behavior, not a model-selected
reaction. The add/remove reaction tools remain available for task-specific agent use,
but the plugin does not currently inject general reaction-etiquette instructions.

Ingress reuses one Paperclip agent session for each Slack conversation so later
messages retain the model's prior context. All messages in one DM share a session,
including threaded replies. Private-group and channel threads use separate sessions
keyed by their root `thread_ts`, and different channels or thread roots never share
context. Only DMs may carry context across Slack threads. The session mapping is
stored in plugin state and is replaced if Paperclip reports that the saved session
is no longer active.

Each inbound turn includes a bounded Slack sender profile from `users.info`, cached
for 24 hours. Email is excluded. DMs may use sender-specific context; private groups
and public channels may use only their own conversation context and the sender's
workspace-visible profile.

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

Historical design context: the first contract mirrored GitHub's local
credential sidecar and proposed storing Slack secret UUIDs there. That design
did not ship. Slack uses company-scoped host config for both credential refs and
does not read or write the local sidecar.

Current shipped company config has this shape:

```json
{
  "identities": {
    "<agent-id>": {
      "label": "Paperclip Agent - QA",
      "teamId": "T0123ABCD",
      "appId": "A0123ABCD",
      "botUserId": "U0123ABCD",
      "defaultChannel": "C0123ABCD",
      "credentials": {
        "botToken": {
          "type": "secret_ref",
          "secretId": "<paperclip-company-secret-uuid-containing-xoxb-token>",
          "version": "latest"
        },
        "signingSecret": {
          "type": "secret_ref",
          "secretId": "<paperclip-company-secret-uuid-containing-signing-secret>",
          "version": "latest"
        }
      }
    }
  }
}
```

The provider validates each reference with the shipped schema:

```ts
const slackSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().trim().uuid(),
  version: z.literal("latest")
});
```

- `credentials.botToken` is required. `resolveSlackCredential` reads it from
  the company config snapshot and resolves it just in time for outbound Slack
  calls. The referenced `xoxb-...` value remains a long-lived bearer token
  because Slack token rotation is deferred.
- `credentials.signingSecret` is also required. The HTTP Events API receiver
  resolves it just in time to verify Slack signatures and the URL-verification
  challenge.
- `save-slack-install-metadata` validates both submitted UUIDs before mutation,
  converts them to typed refs, and writes the identity subtree with one
  `ctx.config.patchSecretRefs` call.

The raw bot token and signing secret live only in Paperclip company secrets.
The settings form accepts their UUIDs or host-provided secret selections, not
the values themselves. Slack has no `privateKeyFile`-style fallback and no
sidecar fallback. The plugin SDK does not create secrets, so the operator must
create both company secrets through the host first.

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
  const { identity, ctx, runCtx } = input;
  const config = await ctx.config.get(runCtx.companyId);
  const secretRef = readSlackSecretRef(config, identity.agentId, "botToken");
  const token = await ctx.secrets.resolve(secretRef, {
    companyId: runCtx.companyId,
    configPath: slackCredentialConfigPath(identity.agentId, "botToken")
  });

  const auth = await verifySlackToken(token);
  if (
    auth.teamId !== identity.identity.teamId ||
    auth.userId !== identity.identity.botUserId ||
    !auth.botId
  ) {
    throw new Error("Slack credential does not match the configured workspace bot identity.");
  }

  return { token, secrets: [token] };
}
```

The production implementation factors this sequence through
`resolveSlackBotToken`, but the boundaries above are exact: read the
host-authorized company snapshot with `ctx.config.get(runCtx.companyId)`, read
only the calling agent's typed ref with `readSlackSecretRef`, and pass both the
company ID and exact config path into `ctx.secrets.resolve`. Missing, malformed,
revoked, or cross-bound refs fail closed. `verifySlackToken` calls `auth.test`
and parses only the documented team, user, and bot identity fields without
including the token or raw response in an error.

The `bot_id` check is mandatory and not redundant with `team_id`/`user_id`:
Slack returns it only for bot tokens. Requiring it rejects a human user token
even if its other IDs could be made to line up. The receiver resolves
`credentials.signingSecret` through the same company-scoped lookup in the
separate `resolveSlackSigningSecret` path; outbound tools never resolve it.

The result remains `{ token, secrets: [token] }` so the pipeline's redact step
can strip the bot token from results. Unlike GitHub, Slack has no token-minting
step: the configured bot token is itself the durable secret. Token rotation
would require refresh-token storage and renewal and remains deferred.

## 6. Tools (MVP)

| Tool | `requiresCredential` | Resource ref | Slack API calls |
| --- | --- | --- | --- |
| `slack_bot_whoami` | `false` | none | none (echoes configured identity fields) |
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

`slack_bot_whoami` is credential-free, matching GitHub's local whoami rather
than diverging from it as an earlier revision of this doc claimed: it has
`requiresCredential: false`, never resolves the bot token, and never calls
`auth.test`. `perform` only reads the already-validated, public
`SlackAgentIdentity` fields (`label`, `teamId`, `appId`, `botUserId`,
`hasDefaultChannel`) that were set at save-config time — there is no live
Slack API call and no independent verification of `teamId`/`botUserId`
against the actual installation. A stale or misconfigured identity is
therefore not caught by this tool; only the four credentialed tools
(`slack_bot_post_message`/`slack_bot_post_reply`/`slack_bot_add_reaction`/
`slack_bot_remove_reaction`), whose credential-resolution step requires
`auth.test` to succeed, catch a broken token/installation.

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

1. Operator enters a public HTTPS Events Request URL. It must have the exact
   `/events` path and no query or fragment. The settings page builds a Slack app
   manifest with bot scopes `app_mentions:read`, `chat:write`, `channels:read`,
   `groups:read`, `im:history`, `reactions:write`, and `users:read`. The manifest
   writes the URL to `settings.event_subscriptions.request_url`, subscribes to
   `app_mention` and `message.im`,
   leaves Socket Mode disabled, copies the JSON, and opens
   `https://api.slack.com/apps` in a separate tab. `chat:write.public` is
   omitted, so the app must be a member of each target channel.
2. Operator chooses **Create New App** -> **From an app manifest**, selects the
   intended workspace, pastes the generated JSON, reviews it, and confirms app
   creation. This documented paste step is required; the MVP does not depend on
   an undocumented `manifest_json` dashboard query parameter. Slack may show
   the Request URL as unverified at this stage; leave it unverified.
3. Operator installs the app to the intended workspace and collects `teamId`,
   `appId`, `botUserId`, the Bot User OAuth Token, and the app's signing secret.
4. Operator creates two Paperclip company secrets through the host UI, one for
   the bot token and one for the signing secret, and copies both secret UUIDs.
   The plugin never receives either raw value through its settings action.
5. Operator enters the three Slack IDs, both secret UUIDs, and an optional
   default channel in the Slack identity form. `save-slack-install-metadata`
   writes the public identity to settings state and persists both typed refs in
   company config with `ctx.config.patchSecretRefs`.
6. Only after step 5 succeeds, operator returns to Slack, retries Request URL
   verification, and saves the manifest changes. The receiver can answer the
   signed URL-verification challenge only after the signing-secret ref exists.

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

The settings page ships a Slack identity form beside the GitHub form. Required
fields are Events Request URL, team ID, app ID, bot-user ID, bot-token company
secret UUID, and signing-secret company secret UUID; default channel is
optional. The flow provides actions to create and copy the manifest, open
Slack's create-app page, resume a short-lived flow, and save install metadata.
It explicitly instructs operators not to verify the Request URL until the
signing-secret ref has been saved. The form never accepts or renders the raw
`xoxb-` token or signing secret.

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
the Slack credential path. Store its typed Paperclip secret ref only at
`identities.<agentId>.credentials.botToken`, resolve it just in time in step 4,
and never write the raw value into config or `ctx` state. Recommend workspace
admins scope the app to the bot scopes in §7 and rotate on any suspected leak;
this plugin cannot force Slack-side rotation, but it can guarantee the token
never appears in agent config, workspace files, tool output, or logs (redact
step 6, plus a hard rule: `perform` must not `console.log` or return raw
response bodies that could embed the token).

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
target. Credential resolution reads only
`identities.<runCtx.agentId>.credentials.botToken` from the host-authorized
company config, passes the company ID and exact config path to secret
resolution, then calls `auth.test`. It requires `team_id` and `user_id` to
match the resolved identity's `teamId` and `botUserId`, and requires `bot_id`
to be present so a user-token credential can never satisfy the check. A
company-config ref pointing at another agent's token, or at a user token,
fails before `perform`.
Contract tests must cover "agent A cannot resolve agent B's identity", "agent
A's company config cannot substitute agent B's valid token", and "a user OAuth
token whose team_id/user_id happen to match is rejected for missing bot_id"
cases.

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

### T5 — Signing-secret / ingress abuse
**Risk:** the HTTP receiver is public-facing; an attacker who can reach it
without a valid Slack signature could spoof events as if from Slack.
**Mitigation (implemented by DRO-1005 and the provisioning follow-up):** the
generated manifest provisions the required HTTPS `/events` Request URL and
subscribes to `app_mention` and `message.im`. The receiver resolves
`identities.<agentId>.credentials.signingSecret`, verifies the
`X-Slack-Signature` and `X-Slack-Request-Timestamp` headers before parsing or
trusting the event body, rejects requests outside Slack's replay window
(roughly 5 minutes), bounds request size and unauthenticated work, and never
logs the signing secret. For temporary local tests,
`scripts/slack-events-adapter.mjs` accepts loopback `POST /events` and forwards
the unchanged body and Slack headers to
`/api/companies/<companyId>/plugins/roshangautam.paperclip-agent-identities/webhooks/slack-events`.
This adapter does not implement Socket Mode.

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
