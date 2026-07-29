# Set up agent identities

Agent Identities connects a Paperclip agent to a provider account. Each agent can have one GitHub identity and one Slack identity.

Open the plugin's **Agent Identities** settings page, then select **Add identity**. Choose the Paperclip agent and provider. The setup wizard shows only the fields required by that provider.

## GitHub

Use a separate GitHub App for each agent.

1. Choose the agent and GitHub provider. Review the generated label, GitHub username, and optional commit identity.
2. Select **Create GitHub App on GitHub**. GitHub opens with the required repository permissions prefilled.
3. Create the app. If the callback does not restore automatically, paste the returned callback URL or one-time `code` into the wizard.
4. Install the app on the repositories the agent may access. Paperclip restores the form with the App ID and Installation ID.
5. Keep the generated private-key file as the credential source, or copy the PEM into a Paperclip secret and select that secret UUID.
6. Save the identity.

Saving projects the GitHub App ID, Installation ID, and private-key reference into the selected agent's environment. A Paperclip secret is preferred when selected. The generated private-key file remains available as a local fallback.

Repository access is controlled by the GitHub App installation. To change access later, update the app installation on GitHub. Replacing an existing identity through the manifest flow creates a new GitHub App, so install the new app before removing the old one.

## Slack

Use a separate Slack App for each agent.

Slack needs a public HTTPS URL to post events to. When Paperclip itself is served
over HTTPS, that URL is this deployment's own webhook route and Settings fills it
in for you — leave the **Events Request URL** field blank. The derived URL is:

```text
https://<your-paperclip-host>/api/companies/<companyId>/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events
```

Enter a URL only to override that default. The common reason is local
development, where Paperclip is served over plain HTTP and Slack cannot reach it,
so you point Slack at a public tunnel in front of the loopback dev adapter
described in [Slack provider MVP](../domain/slack-provider-mvp.md). In
that case Settings marks the field required, because there is nothing to derive.

1. Choose the agent and Slack provider.
2. Leave **Events Request URL** blank to use this deployment's own endpoint, or
   enter an override, then select **Create Slack App manifest**.
3. Copy the formatted manifest JSON. Open Slack's app creation page, choose **From an app manifest**, select the workspace, and paste the manifest.
4. Create and install the Slack App. The manifest prefills the bot features, required OAuth scopes, Events API Request URL, and event subscriptions.
5. Copy the bot token and signing secret into separate Paperclip company secrets. If you create these secrets while the identity dialog is already open, select **Refresh secrets** next to the bot-token/signing-secret dropdowns to re-query this company's secrets without closing the dialog or losing anything you've already entered.
6. Select the bot token secret in the wizard, then use **Detect Slack installation IDs** to fill the Team ID, App ID, and Bot User ID.
7. Select the signing secret and optionally enter a default channel ID. Channel names such as `#daily-news` are not accepted. Use a Slack channel ID beginning with `C`, `D`, or `G`.
8. Save the Slack install metadata, check the connection status, and save the identity.

**Refresh secrets** is available on both the GitHub and Slack credential steps. It re-fetches only the current company's secrets — every other field (agent, provider, label, manifest-flow state, detected IDs, and any values you've typed but not saved) stays exactly as it was. If a secret you had selected is deleted or renamed before you refresh, the field shows an explicit error asking you to pick a valid secret instead of silently keeping or switching the reference. A failed refresh leaves the previously loaded options in place with a retryable error, and the button disables itself (with a "Refreshing..." status) while a request is in flight so repeated clicks can't fire duplicate requests.

The Events Request URL is embedded verbatim into the generated manifest, so it is
locked once the manifest exists. To change it, start a new manifest flow.

Invite the bot to any public channel where it should receive mentions or post messages. Direct messages are delivered without a channel invitation. Top-level direct messages receive top-level replies. Public-channel mentions receive threaded replies.

If you change the manifest permissions or events after installing the app, reinstall it in Slack so the new grants take effect.

### Configured vs. Connection (DRO-1161)

Once a Slack identity is saved, Settings shows two distinct panels instead of a single "Ready" state:

- **Configured** (`slack_bot_whoami`) reflects saved install metadata only -- team/app/bot IDs and secret references. It does not verify the bot token is still valid.
- **Connection** runs a bounded, secret-free live Slack `auth.test` against the resolved bot credential. It never exposes the token to the browser or agent. Select **Check Slack connection** to run it on demand.

The Connection panel has four states: **never tested** (no check has run yet), **loading**, **connected** (with the timestamp of the last successful check), and **not connected** (with a safe error category/reason and a next-step hint). A successful result is marked **stale** once it is more than 5 minutes old, or immediately if a subsequent refresh attempt fails -- a stale result is never presented as current health. Switching identities (or closing and reopening the edit dialog) clears the previous identity's Connection result so it can never render under a different identity's label.

Ingress (event verification/routing) and Delivery (enqueue/drain/session completion) health are tracked separately; see [DRO-1187](https://paperclip.roshangautam.com/DRO/issues/DRO-1187).

### Ingress and Delivery telemetry (DRO-1187)

Below Connection, Settings shows two more panels reflecting real Slack activity for this identity, not a live check:

- **Ingress** reflects the most recent verified Slack event: its bounded event type (`message`/`app_mention`/`other` -- never the event text), whether it routed to exactly one agent, and, on failure, a bounded category (`signature_failed`/`routing_failed`) with operator next-step guidance.
- **Delivery** reflects the most recent durable-queue phase: enqueue, session/drain start, completion, or failure (`queue_failed`/`session_failed`/`reply_failed`, each with guidance).

Both panels show **Never observed** until the identity has actually processed a Slack event -- there is nothing to check on demand, so both refresh automatically whenever you view the identity, and (like Connection) preserve the last known result and mark it stale on a refresh failure rather than clearing it. Neither panel ever shows message text, prompts, model output, tokens, signing secrets, or raw Slack payloads -- only bounded categories, timestamps, and the already-public `teamId`/`appId` scoping identifiers.

### Upgrade from v0.1.7 or v0.1.8

Before upgrading, confirm every Slack identity appears in Agent Identities settings. Static
company config is no longer a runtime identity fallback. If older v4 settings state has no Events
Request URL, the edit form prefills the retained host value; save the install to persist it in v5
state. That compatibility value is never used by tools or webhook routing.

Those released versions stored the Slack bot-token company-secret UUID, and
sometimes the signing-secret UUID, under
`identities.<agentId>:slack.slackBotToken` in the local credential sidecar. The
current runtime intentionally does not use that sidecar as a token fallback.

If a row shows **Rebind required**, edit it and choose **Rebind released
credentials**. When prompted, select or paste the UUID of the existing
Paperclip company secret containing the Slack signing secret. The action checks
the host-authorized company and agent membership and copies only typed UUID
references into `identities.<agentId>.slack.credentials`; it never reads or displays either
secret value. **Cleanup pending** means the host binding works but deleting the
legacy sidecar entry failed; retry the same action. **Conflict** means an
existing host Slack binding differs and must be reviewed rather than
overwritten. None of these recovery states requires reinstalling the Slack App.

## Tool availability in agent sessions

This plugin declares its tools (`github_bot_whoami` and the other GitHub bot
tools, plus the Slack tools) globally and registers their handlers whenever its
worker starts. That registration is necessary but not sufficient for an agent
to actually see or call a tool inside a given run: the agent's adapter must
also attach the per-run tool-gateway MCP server (built from a non-empty
`ctx.runtimeMcp`) and
authenticate with the short-lived, run-scoped gateway credential Paperclip
issues for that run. Global registration and per-session availability are
different properties, and only the first is under this plugin's control.

If an agent session reports a tool as "not available" even though the plugin
is installed and the identity is configured, start from the Paperclip run ID.
Inspect the named gateway's `heartbeat_run` token whose `subjectId` matches
that run. A non-null `lastUsedAt` on that token proves that exact credential was
used. A `tool_gateway.discovery` or tool-call event in
`/api/tool-gateway/audit` is relevant only when its `gatewayId` and
`gatewaySessionId` match the named gateway session; the same `runId` alone is
not enough because the raw HTTP workaround can mint an independent session for
the run. A null token `lastUsedAt` proves only that the named credential was not
used; it does not distinguish a missing attachment from a request that omitted
the header or never reached the gateway. Correlate adapter config, run output,
gateway audit, and transport evidence before naming the failure mode. Do not use
`/api/tool-gateway/sessions` as an inspection endpoint; that route only creates
sessions (with a separate revoke route).

- `codex_local`: the investigated run received a managed MCP config, but
  Paperclip wrote the bearer map under unsupported `headers` instead of
  Codex's `http_headers`, so Codex discarded the credential and
  `github_bot_whoami` was unavailable. Tracked upstream at
  [paperclipai/paperclip#10346](https://github.com/paperclipai/paperclip/issues/10346);
  the narrow fork fix is
  [roshangautam/paperclip#19](https://github.com/roshangautam/paperclip/pull/19).
- `hermes_local`: does not wire `ctx.runtimeMcp` into the Hermes process at
  all. Tracked upstream at
  [paperclipai/paperclip#10144](https://github.com/paperclipai/paperclip/issues/10144).
- Cursor / Claude Code adapters: plugin tools are not yet bridged as native
  MCP tools for these adapters. Tracked upstream at
  [paperclipai/paperclip#6707](https://github.com/paperclipai/paperclip/issues/6707).

Do not work around a managed-tool availability failure with direct `curl`/shell or
`gh api` calls to provider APIs. Those direct provider calls bypass the
managed tool gateway, identity policy, and audit path this plugin depends on.
The raw Paperclip tool-gateway HTTP API is different: calls authenticated with
the run JWT and short-lived gateway token remain policy-checked and audited,
as documented for the temporary `hermes_local` workaround in
[paperclipai/paperclip#10144](https://github.com/paperclipai/paperclip/issues/10144).
That adapter-specific HTTP flow is still not the native managed MCP surface
and does not prove attachment works. Treat it as a temporary workaround while
escalating the missing MCP attachment as an adapter bug, not as a core fix.

This repo's compatibility check
(`tests/providers/github/session-tool-availability.spec.ts`) compares the
current manifest with the independently recorded incident fixture
(`tests/fixtures/session-tool-discovery/incident-codex_local.json`). The
fixture records only established facts: runtime MCP and managed config were
present, the credential was not used, transport reachability was unknown, and
`github_bot_whoami` was reported unavailable. It does not reconstruct a raw
`tools/list` capture or prove a healthy path. Until a corrected Paperclip core
build is running and an authenticated live session produces discovery/audit
evidence, treat `codex_local` tool availability as unverified in production.

## Edit or remove an identity

Use **Edit** on a configured identity to update its provider metadata or credential references. Use **Delete** to remove only that provider's mapping from Paperclip; deleting Slack also removes that identity's exact released legacy Slack sidecar entry after host/state deletion succeeds, while preserving all GitHub entries. Deleting an identity does not delete the GitHub App or Slack App from the provider, so remove the provider app separately if it is no longer needed.

Raw private keys, bot tokens, and signing secrets should never be pasted into identity metadata fields, logs, issues, or documentation. Store them in Paperclip secrets or the generated local key file where supported.
