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
and calls `ctx.config.patchSecretRefs` to write only the company-scoped refs at
the credential path selected by `slackCredentialsConfigPath`: the nested path
for current records or the existing flat path for a legacy record. Current
runtime credential resolution does not use the local credential sidecar; it is
inspected only by the one-release legacy migration path described below.

Historical design context: the initial plan called for a provider dispatch
table that returned a normalized sidecar credential and extended the GitHub
sidecar schema for Slack. That shape did ship in `v0.1.7` and `v0.1.8` as
`identities.<agentId>:slack.slackBotToken`, before company-scoped typed
secret-ref persistence replaced it. Current runtime credential resolution uses
only the company host-config path. The legacy parser remains for one
compatibility release and an explicit, company-authorized rebind action moves
the typed UUID refs without resolving secret values.

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
  HTTP Events API receiver and message subscriptions are shipped; these
  additional transports and interactive event types remain deferred.
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
HTTPS URL with no query, fragment, or embedded credentials, writes it to
`settings.event_subscriptions.request_url`, subscribes to `message.im` and
`app_mention` plus `message.channels`, `message.groups`, and `message.mpim`,
and requests the corresponding history scopes. Socket Mode remains deferred.

A top-level `app_mention`, `@channel`, `@here`, or `@everyone` starts a Slack
thread rooted at that event's `ts`.
Mentions received inside an existing thread keep their original `thread_ts`.
Top-level direct messages receive one final response in the main DM, and only
use a thread when the inbound DM already has `thread_ts`. Slack does not expose
the human composer typing indicator to bots through its official Web API. The
receiver uses `assistant.threads.setStatus` for supported assistant threads and
falls back to a temporary `:paperclip:` reaction on the inbound
message when thread status is unavailable. The reaction is removed when processing
ends. It does not simulate typing by posting and later editing a placeholder message.
This processing indicator is deterministic receiver behavior, not a model-selected
reaction. The add/remove reaction tools remain available for task-specific agent use,
but the plugin does not currently inject general reaction-etiquette instructions.

Ingress reuses one Paperclip agent session for each Slack conversation so later
messages retain the model's prior context. All messages in one DM share a session,
including threaded replies. Private-group and channel threads use separate sessions
keyed by their root `thread_ts`, and different channels or thread roots never share
context. Only DMs may carry context across Slack threads.

When the first routed turn is an `app_mention` inside an already-existing channel or
private-group thread, the drain resolves the exactly routed identity's verified bot
token and calls `conversations.replies` for only the inbound event's canonical
`channel` and `thread_ts`. Hydration is skipped for root mentions and for any
conversation that already has a Paperclip session, so successor turns rely on the
session instead of repeatedly reloading Slack history. Retrieval is capped at three
pages of 100 source rows, 20 projected messages, 8 KiB of serialized quoted history,
2,048 UTF-8 bytes per message, and a two-second timeout. Rows are deduplicated by
timestamp, filtered to messages before the current event, and sorted chronologically.
The projection preserves only timestamp, root-thread timestamp, bounded user/bot ID,
bounded text, and a deletion tombstone; attachments, blocks, `previous_message`,
transport IDs, and other envelope metadata are discarded. Missing scope, rate limit,
timeout, deletion races, malformed cross-channel/thread rows, and other Slack API
failures degrade to the current-message prompt with a stable secret-free warning.

The invocation prompt separates verified routing/privacy metadata, explicitly quoted
untrusted thread history, and the current Slack user message. Quoted history never
receives instruction authority, even when its text is shaped like a system prompt.

The webhook never waits behind that session. After signature/routing checks, it
persists a bounded safe turn in one version-2 per-conversation state record, awaits
a company-scoped `slack-turn-drain` self-event emit, and acknowledges. The record
contains the session mapping, FIFO pending turns (32 active/pending maximum), one
active phase (`active`, `accepted`, or `uncertain`), and up to 1,024 hashed event
claims. Pending and active hashes do not expire. Completed claims expire 24 hours
after completion, well beyond Slack's retry horizon and the 30-minute run lease.
Duplicates in any phase re-kick but do not enqueue again. Plain replies in unowned
threads are completed without dispatch, preserving fail-closed ownership.
Queue-full errors are explicitly retryable and occur before the webhook can ack.
Persisted turn metadata records whether ownership came from a DM, app mention,
broadcast, or an already-owned reply so the drain can revalidate that boundary.
The plugin-state API remains last-write-wins rather than CAS; enqueue uses a
unique claim token plus write/read-back confirmation to detect observable races,
but cross-worker exactly-once claiming still requires a host transaction primitive.
Self-event drains are serialized per `(company, agent, conversation)` only within
one worker process; the durable active claim is the restart/cross-worker backstop.
Persisted Slack text is truncated safely to 4,096 UTF-16 code units and bounded to 64 KiB; IDs and
event IDs are separately bounded (oversized event IDs fail before ack), and
arbitrary envelope fields are never stored.
The design removes agent-session create/list/send/close and agent-run waiting from
Slack's three-second HTTP budget; host
config, secret, state, and event-bus RPC latency still remains inside that budget.
Ingress logs use only stable classifications and agent IDs; raw Slack text,
event IDs, session IDs, run IDs, and transport error messages are not logged.

The provider registers exactly one self-event handler through its existing setup
contribution. Duplicate drain notifications are coalesced per conversation in-process.
The handler's batch size is exactly one turn under fresh company scope, records the accepted
run ID, buffers callbacks received before `sendMessage` returns, and ignores stale
run/session callbacks. Terminal handling awaits stream/post finalization, then marks
the event completed, clears active state, and emits the successor kick. No detached
timer calls host APIs. Structured adapter output is reduced to user-facing reply text;
ACPX `acpx.text_delta` records are accepted as Slack reply content only when they carry
the DRO-1183 provenance discriminator `provenance: "assistant"` on channel `output`.
That field is the stable contract separating assistant-authored prose from adapter,
transport, status, warning, and stderr content (see
`docs/adapters/acpx-event-provenance.md` in core); classification fails closed upstream,
so a transport warning emitted before the first genuine assistant delta is never marked
`assistant`. Records with `provenance` of `tool`, `transport`, `error`, or any
unrecognized value are dropped, as are assistant-provenance deltas on the `thought`
channel.

Records with **no** `provenance` field at all are the pre-DRO-1183 ambiguous shape
(type `acpx.text_delta` + channel `output` + tag `agent_message_chunk`), in which a
transport/adapter diagnostic — e.g. a "Model metadata not found, defaulting to fallback
metadata" warning, see terminal-surface report `paperclipai/paperclip#1465` — is
structurally indistinguishable from genuine assistant prose. The DRO-1162 guard is
retained for the bounded transition window: that ambiguous source is dropped rather than
accumulated, streamed, or delivered at turn completion. Confirmed records (`result`,
`item.completed`, a Claude `content_block_delta`, or a Gemini/assistant message) still
preserve genuine assistant prose, including text that quotes or explains the same
warning, while non-JSON adapter stdout remains available as the bounded compatibility
fallback. The old-shape guard can be removed once no live surface replays pre-contract
run logs. The persisted
`retireAfter` is a
30-minute durable accepted
lease and is retired only when a
later webhook/self-event supplies host scope; a fresh terminal session callback
can finalize its own accepted run.
An agent terminal `error` also retires the mapped session before the successor
kick, so later context does not reuse a failed session.
Before any send, the fresh drain snapshot revalidates that the configured Slack
app/team route still matches the queued conversation; a rebind blocks the queued
turn rather than sending it through a different identity. It also revalidates
that the target agent still belongs to the fresh company scope. Removing the
identity or changing its app/team therefore leaves the turn durable and unsent.
An expired pre-send claim is requeued only if no session was attached, or if a
fresh session-list check proves that the merely reused mapped session is still
active. Once a newly created/attached session makes send acceptance ambiguous,
the claim is retired rather than replayed.

Only the exact host `Session not found` response proves a send was not accepted and
permits one replacement-session retry. Any other `sendMessage` failure is ambiguous:
the provider persists `uncertain`, closes/retires that session, completes the event
claim, and never auto-resends. The host has no request-key or accepted-run
cancellation API, so exactly-once execution cannot be claimed beyond this boundary.
Closing retires callback/session reuse but cannot prove an underlying run stopped.
A failed session close leaves the durable `uncertain` phase in place and blocks
the successor; a later fresh trigger retries retirement rather than reusing the
session or resending the claimed turn.
A worker restart plus a later duplicate/new webhook re-kicks durable work; restart
after acknowledgement with no later trigger still requires host durable scheduling
or request-key support. The same trigger limitation applies if a terminal successor
emit fails after state finalization: the successor remains queued and a later
duplicate/new webhook resumes it.

An ordinary channel, private-channel, or multi-person DM message is dispatched
only when it is a threaded reply and the routed agent already has a session
mapping for that exact thread. An initial `app_mention` or Slack broadcast token
(`<!channel>`, `<!here>`, or `<!everyone>`) creates that ownership mapping. A
broadcast inside a thread may also create the routed agent's mapping for that
thread. Plain replies in unowned threads and top-level messages without a
mention or broadcast are acknowledged and ignored.

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
credential sidecar and stored Slack secret UUIDs there in released `v0.1.7` and
`v0.1.8`. Slack runtime calls now use company-scoped host config for both refs.
The sidecar is read only to project migration status and service the explicit
rebind/cleanup action during one compatibility release.

Current shipped company config has this shape:

```json
{
  "identities": {
    "<agent-id>": {
      "slack": {
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
  converts them to typed refs, and writes only the credential subtree with one
  `ctx.config.patchSecretRefs` call scoped to
  `identities.<agentId>.slack.credentials` for current records and the existing
  flat credential path for a legacy record. Public install metadata remains in
  plugin state. Public fields retained in earlier host records are ignored at
  runtime because settings state is authoritative.
- Identity deletion clears the credential subtree whenever it contains at
  least one valid bound ref, including incomplete legacy bindings. It skips an
  empty or wholly invalid container because the host rejects a secret-ref patch
  when nothing is bound. If the state deletion fails, rollback restores only
  refs that pass `slackSecretRefSchema`; malformed values are never copied into
  `patchSecretRefs`.
- The manifest declares each credential as `type: string` with
  `format: secret-ref`; Paperclip stores typed refs but projects them to their
  secret UUIDs before validating config patches against that schema. These
  fields stay on direct object-property paths rather than inside `oneOf` or
  `anyOf`, because the host rejects ambiguous secret-binding paths.
- Short-lived discovery metadata entries accept the empty object left when
  Paperclip removes their bound secret leaf; rejecting that host-produced
  cleanup shape would make an otherwise successful discovery action fail.

The raw bot token and signing secret live only in Paperclip company secrets.
The settings form accepts their UUIDs or host-provided secret selections, not
the values themselves. Slack has no `privateKeyFile`-style fallback and no
sidecar fallback. The plugin SDK does not create secrets, so the operator must
create both company secrets through the host first.

Released-sidecar migration is explicit, not a bare-UUID runtime fallback.
`rebind-legacy-slack-credentials` requires the host-authorized `companyId`,
revalidates agent membership, requires an existing public Slack settings
identity, and rejects a conflicting complete host binding. A metadata-only or
incomplete host record remains eligible for rebind. The action copies the
released bot token UUID and either the released signing-secret UUID or an
operator-supplied signing-secret UUID into typed refs. It then deletes only the
exact legacy Slack entry, preserving sibling GitHub entries. Cleanup failure
leaves the working host binding in place and projects `cleanup-pending` for a
safe retry.

Process-local queues serialize metadata discovery by `(state client,
companyId, secretId)` and Slack settings mutations by the shared settings
document plus `(companyId, agentId)`. Discovery markers are versioned and
owner-qualified, while legacy `{ path }` markers remain recoverable. During
marker recovery and final cleanup, the exact host error
`config.patchSecretRefs found no bound secret refs to remove` is treated as an
idempotent success because a prior binding attempt may have failed before the
marker could be cleared; other cleanup errors remain fatal and preserve the
marker. The host state/config APIs expose no compare-and-set transaction, so
these guarantees do not extend across multiple worker processes; a host
CAS/transaction primitive is required for cross-worker atomicity.

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
    configPath: slackSecretRefConfigPath(config, identity.agentId, "botToken")
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
company ID and exact config path into `ctx.secrets.resolve`. The path helper
retains the flat legacy path while reading or updating a record written by an
earlier build of this PR. Missing, malformed,
revoked, or cross-bound refs fail closed. `verifySlackToken` calls `auth.test`
under one two-second deadline spanning both the host fetch and response-body
read, then parses only the documented team, user, and bot identity fields
without including the token or raw response in an error.

The `bot_id` check is mandatory and not redundant with `team_id`/`user_id`:
Slack returns it only for bot tokens. Requiring it rejects a human user token
even if its other IDs could be made to line up. The receiver resolves
`slack.credentials.signingSecret` through the same company-scoped lookup in the
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

1. Settings resolves the Events Request URL. When Paperclip is served over HTTPS
   it derives this deployment's own webhook route
   (`<origin>/api/companies/<companyId>/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events`)
   and the operator field is an optional override; over plain HTTP nothing is
   derivable and the operator must supply a public tunnel URL. Any HTTPS URL with
   no query, fragment, or embedded credentials is accepted. The settings page builds a Slack app
   manifest with bot scopes `assistant:write`, `app_mentions:read`, `chat:write`,
   `channels:history`, `channels:read`, `groups:history`, `groups:read`,
   `im:history`, `mpim:history`, `reactions:write`, and `users:read`. The manifest
   writes the URL to `settings.event_subscriptions.request_url`, subscribes to
   `app_mention`, `message.channels`, `message.groups`, `message.im`, and
   `message.mpim`,
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
fields are team ID, app ID, bot-user ID, bot-token company
secret UUID, and signing-secret company secret UUID; default channel is
optional. Events Request URL is required only when it cannot be derived from the
host origin (see §7 step 1); otherwise it is an optional override. The flow provides actions to create and copy the manifest, open
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
`identities.<agentId>.slack.credentials.botToken`, resolve it just in time in step 4,
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
`identities.<runCtx.agentId>.slack.credentials.botToken` from the host-authorized
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
generated manifest provisions the required HTTPS Request URL and
subscribes to `app_mention`, `message.channels`, `message.groups`, `message.im`,
and `message.mpim`. For normal callbacks the receiver extracts bounded
`team_id` and `api_app_id` values as untrusted routing hints, intersects public
identities from `CONFIG_SCOPE` with company config entries that contain both
required credential refs, resolves only the exactly routed identity's
`identities.<agentId>.slack.credentials.signingSecret`, and verifies
the untouched raw body before trusting or dispatching the full envelope.
Requests without usable hints use a bounded parallel verification fallback.
The receiver rejects requests outside Slack's replay window (roughly 5
minutes), bounds request size and unauthenticated work, and never logs or caches
the signing secret. For temporary local tests,
`scripts/slack-events-adapter.mjs` accepts loopback `POST /events` and forwards
the unchanged body and Slack headers to
`/api/companies/<companyId>/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events`.
This adapter does not implement Socket Mode.

**`channel_type` normalization for `app_mention` (DRO-1156):** production
`app_mention` events may omit `event.channel_type` entirely; Slack does not
guarantee it is present on that event type. The durable queue
(`enqueueSlackConversationTurn`) still requires a concrete non-direct
`channelType` (`channel`, `group`, or `mpim`) and never relaxes that
invariant. Instead, `projectQueuedTurnEvent` in
`src/providers/slack/ingress/provider-webhook.ts` normalizes the missing
field once at the ingress trust boundary, after signature verification and
before durable persistence: a validated `C…` conversation ID infers
`channel`, a validated `G…` ID infers `group`. An explicit `channel_type` is
still accepted, but only when it agrees with the conversation ID's prefix —
a contradicting explicit type (e.g. `channel_type: "group"` with a `C…` ID)
fails closed before any queue write, as do direct-message (`D…`), blank,
malformed, and unknown-prefix conversation IDs for `app_mention`. This keeps
the fix scoped to ingress normalization rather than weakening the queue's
validation, and matches the regression fixtures in
`tests/providers/slack/ingress-provider-webhook.spec.ts` that intentionally
omit `channel_type` from a production-shaped `app_mention` payload.

#### Thread-history hydration boundary
**Risk:** a first mention in an existing thread could cause cross-channel disclosure,
unbounded Slack reads, repeated history amplification, or prompt injection from an
earlier participant.
**Mitigation (implemented by DRO-1158):** history lookup is permitted only after
signature verification, exact `(team_id, api_app_id)` identity routing, company-scoped
config resolution, and verified bot-token binding. The request uses only the routed
event's channel and root timestamp, never search or link traversal. Page, message,
serialized-byte, per-message, and timeout limits are fixed constants. Response rows
with a conflicting channel or thread fail closed; only messages preceding the current
event are projected. Unsupported metadata is dropped, deleted messages become empty
tombstones, and the prompt labels all retained history as quoted untrusted data below
verified metadata and above the separately labeled current message. Failures are
non-fatal and logged without Slack errors, message text, credentials, or transport
metadata. Existing session mappings suppress later rehydration.

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

### T7 — Live connection-check triggers as a new caller path to the credential (DRO-1161)
**Risk:** `check-slack-connection` (`src/providers/slack/connection-status.ts`)
introduces a new, human-operator-triggered live call to Slack's `auth.test`
using the resolved bot token — a second code path (alongside
`resolveSlackCredential`/the tool pipeline) that touches the credential. A
bug here could either leak the token to the Settings UI, or become an
unbounded/uncapped way to hammer Slack's `auth.test` endpoint from a
company's own settings page.
**Mitigation:** `runSlackConnectionCheck` reuses `resolveSlackBotToken`
itself (not a parallel re-implementation) so it inherits the exact same
fail-closed checks as tool credential resolution (workspace match, bot- vs
user-token rejection, `botUserId` match) — "Connection: ok" cannot mean
anything looser than what a real tool call would also accept. The action's
return value is a closed, bounded shape
(`{ outcome: { ok, category?, reason? }, checkedAt, nextStep? }`) built by
`categorizeConnectionError`, which maps thrown errors to one of seven fixed
category strings — the resolved token, the raw Slack response body, and the
original thrown `Error.message` are never included. The check is also
capped at a fixed 8s timeout (`SLACK_CONNECTION_CHECK_TIMEOUT_MS`) via
`withTimeout`, and the action itself is gated the same way every other
settings action is (`context.companyId` is host-authorized, never a
caller-supplied `params.companyId`); the operator UI additionally only
allows one check at a time per identity (loading-gated button), so this
does not add a new unbounded-retry surface against Slack's API. Test
coverage (`tests/providers/slack/connection-status.spec.ts`) explicitly
asserts the token never appears in the serialized result, including on a
Slack error body engineered to echo the token back.

### T8 — Ingress/Delivery telemetry storage and exposure (DRO-1187)

**Risk:** unlike Connection (an on-demand call), Ingress/Delivery telemetry
(`src/providers/slack/telemetry.ts`) is *recorded* continuously as real
webhook/queue/session activity happens, and its read path
(`get-slack-telemetry`) is a new, always-available settings action. Two
distinct risks follow: (1) an unbounded or unredacted record could
accumulate message content, tokens, or other sensitive operational detail
over time in plugin state, turning a health signal into a secondary secret
store; (2) a bug in the read action could leak one company/agent's telemetry
to another's Settings view.
**Mitigation:** the persisted `SlackTelemetryRecord` shape is a small, fixed,
`structuredClone`-serializable record — only ISO/epoch-ms timestamps, closed
enum categories (`SlackIngressEventTypeCategory`, `SlackIngressFailureCategory`,
`SlackDeliveryFailureCategory`), and the same correlation-safe `teamId`/
`appId`/`companyId` identifiers already treated as safe throughout this
provider (never message text, prompts, model output, tokens, signing
secrets, HTTP headers, or stack traces). There is no caller-supplied
free-text `reason` field at all: every failure carries only its closed-enum
`category` and that category's fixed, static `nextStep` guidance string, so
there is no per-call text that could ever carry a raw thrown `Error.message`
or Slack response body into storage. There is no historical log — each write
replaces the single bounded record for that (companyId, agentId) scope, so
there is no unbounded growth path. The read action
(`contributeSlackTelemetryAction`/`get-slack-telemetry`) validates
`agentId`/`companyId` from `params`/`context` exactly like
`check-slack-connection` (`context.companyId` is host-authorized, never a
caller-supplied `params.companyId`), and — because the underlying state key
is scoped by `agentId` alone, not `companyId` — `getSlackTelemetry` also
checks the stored record's own `companyId` against the caller's authorized
`companyId` before returning it, so a known/guessed `agentId` alone can
never disclose another company's telemetry for that agent. Test coverage
(`tests/providers/slack/telemetry.spec.ts`) explicitly asserts per-agent
scoping (one agent's record never leaks into another's projection), a
dedicated cross-company case (a shared `agentId` recorded under one company
never projects for a different caller `companyId`, at both the module and
registered-action layers), and that
the persisted record and its projection never contain secret-shaped content.

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
