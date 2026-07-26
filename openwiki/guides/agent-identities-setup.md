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
5. Copy the bot token and signing secret into separate Paperclip company secrets.
6. Select the bot token secret in the wizard, then use **Detect Slack installation IDs** to fill the Team ID, App ID, and Bot User ID.
7. Select the signing secret and optionally enter a default channel ID. Channel names such as `#daily-news` are not accepted. Use a Slack channel ID beginning with `C`, `D`, or `G`.
8. Save the Slack install metadata, check the connection status, and save the identity.

The Events Request URL is embedded verbatim into the generated manifest, so it is
locked once the manifest exists. To change it, start a new manifest flow.

Invite the bot to any public channel where it should receive mentions or post messages. Direct messages are delivered without a channel invitation. Top-level direct messages receive top-level replies. Public-channel mentions receive threaded replies.

If you change the manifest permissions or events after installing the app, reinstall it in Slack so the new grants take effect.

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

## Edit or remove an identity

Use **Edit** on a configured identity to update its provider metadata or credential references. Use **Delete** to remove only that provider's mapping from Paperclip; deleting Slack also removes that identity's exact released legacy Slack sidecar entry after host/state deletion succeeds, while preserving all GitHub entries. Deleting an identity does not delete the GitHub App or Slack App from the provider, so remove the provider app separately if it is no longer needed.

Raw private keys, bot tokens, and signing secrets should never be pasted into identity metadata fields, logs, issues, or documentation. Store them in Paperclip secrets or the generated local key file where supported.
