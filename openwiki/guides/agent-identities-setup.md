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

Use a separate Slack App for each agent. You need a public HTTPS URL ending in exactly `/events` that forwards requests to this plugin's Slack webhook.

1. Choose the agent and Slack provider.
2. Enter the public Events Request URL and select **Create Slack App manifest**.
3. Copy the formatted manifest JSON. Open Slack's app creation page, choose **From an app manifest**, select the workspace, and paste the manifest.
4. Create and install the Slack App. The manifest prefills the bot features, required OAuth scopes, Events API Request URL, and event subscriptions.
5. Copy the bot token and signing secret into separate Paperclip company secrets.
6. Select the bot token secret in the wizard, then use **Detect Slack installation IDs** to fill the Team ID, App ID, and Bot User ID.
7. Select the signing secret and optionally enter a default channel ID. Channel names such as `#daily-news` are not accepted. Use a Slack channel ID beginning with `C`, `D`, or `G`.
8. Save the Slack install metadata, check the connection status, and save the identity.

Invite the bot to any public channel where it should receive mentions or post messages. Direct messages are delivered without a channel invitation. Top-level direct messages receive top-level replies. Public-channel mentions receive threaded replies.

If you change the manifest permissions or events after installing the app, reinstall it in Slack so the new grants take effect.

## Edit or remove an identity

Use **Edit** on a configured identity to update its provider metadata or credential references. Use **Delete** to remove the mapping from Paperclip. Deleting an identity does not delete the GitHub App or Slack App from the provider, so remove the provider app separately if it is no longer needed.

Raw private keys, bot tokens, and signing secrets should never be pasted into identity metadata fields, logs, issues, or documentation. Store them in Paperclip secrets or the generated local key file where supported.
