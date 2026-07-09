# Agent identity domain

## Core model

The canonical identity and provider types live in `/src/shared/types.ts`.

An `AgentIdentityConfig` represents one Paperclip agent's identity for one provider. The durable identity key is `${agentId}:${provider}`.

- `id`: stable identity key, for example `agent-123:github`.
- `agentId`: Paperclip agent ID.
- `provider`: identity provider ID. GitHub is enabled today; Slack, Mattermost, Microsoft Entra, Google Cloud, and AWS are listed as coming soon.
- `label`: human-readable name shown in settings and tool output. The UI convention is `Agent Name [Company Name]`.
- `githubUsername`: GitHub App login for GitHub identities, commonly `<app-slug>[bot]`.
- `commitName` / `commitEmail`: optional commit author metadata.

Settings state is versioned:

```ts
{
  version: 3,
  identities: Record<`${agentId}:${provider}`, AgentIdentityConfig>
}
```

The worker stores this under `CONFIG_SCOPE` from `/src/config-source.ts`: `{ scopeKind: "instance", stateKey: "bot-identity-config" }`. Runtime GitHub tools filter this provider-aware state to `provider: "github"` and project it into their GitHub-specific config shape by `agentId`.

## Provider authorization

Agent Identities does not implement repository/resource authorization. It maps agents to provider identities and credentials, then lets the provider enforce access through installation permissions, scopes, provider APIs, and tool-specific responses.

`/src/identity-policy.ts` is used by runtime tools. It:

- parses plugin config with a zod schema;
- resolves the calling `runContext.agentId` to the GitHub provider identity projected as `identities[agentId]`;
- normalizes GitHub repository references from inputs such as:
  - `owner/repo`
  - `https://github.com/owner/repo(.git)`
  - `github.com/owner/repo`
  - `git@github.com:owner/repo.git`
  - `ssh://git@github.com/owner/repo.git`
  - `git://github.com/owner/repo.git`;
- rejects malformed or non-GitHub URL-like repository inputs before resolving credentials.

For GitHub, repository access is controlled by the GitHub App installation and GitHub API permissions. The push tool also supports `expectedRepository` as a caller-supplied remote mismatch guard; it is not an authorization policy.

## Config source behavior

`/src/config-source.ts` bridges static plugin config and settings UI state.

`resolveAgentIdentityFromPluginSettings(ctx, runCtx)`:

1. calls `ctx.config.get()` and tries `/src/identity-policy.ts` resolution;
2. if that fails and settings state exists, normalizes settings state and retries;
3. if both fail, throws an error containing the primary and fallback reasons.

Current behavior accepts version 3 provider-aware settings state only. GitHub tool config is derived by filtering identities to `provider: "github"`; disabled or unknown provider records are ignored during normalization. The current settings UI cascades GitHub App credentials to the selected agent identity.

## Credential sidecar

Private credential references live outside plugin state in a local JSON sidecar handled by `/src/credential-sidecar.ts`.

Path resolution order:

1. `PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS`
2. `/paperclip/.paperclip/agent-identities/credentials.json`

Sidecar schema version 1 maps provider-aware identity keys to credential sources:

```json
{
  "version": 1,
  "identities": {
    "<agent-id>:github": {
      "githubApp": {
        "appId": "<github-app-id>",
        "installationId": "<github-installation-id>",
        "privateKeySecretId": "<paperclip-secret-uuid>",
        "privateKeyFile": "/paperclip/.paperclip/agent-identities/github-apps/<agent-id>/private-key.pem"
      }
    }
  }
}
```

Supported credential sources:

- `githubApp`: preferred source. Requires `appId`, `installationId`, and either `privateKeySecretId` or `privateKeyFile`.
- `secretId`: fallback Paperclip secret containing a token.
- `tokenFile`: fallback token file path.

Sidecar writes use a temp file followed by rename and mode `0600`. The settings worker actions upsert or delete individual sidecar identity entries when the UI saves or deletes identities.

## GitHub App token minting

`resolveIdentityToken()` in `/src/credential-sidecar.ts` resolves credentials just in time:

1. sidecar GitHub App credentials;
2. sidecar `secretId`;
3. sidecar `tokenFile` if secret resolution fails or no secret ID exists.

For GitHub App credentials, the code:

- resolves the private key from Paperclip secret first, falling back to the configured private key file;
- normalizes escaped `\n` private-key content;
- creates an RS256 JWT with `iss = appId`, a backdated `iat`, and a roughly 9-minute expiry;
- calls `POST https://api.github.com/app/installations/{installationId}/access_tokens`;
- returns the installation token without storing it.

Errors may include sidecar or configured file paths, but the inspected code avoids returning secret values.

## Settings UI behavior

`/src/ui/SettingsPage.tsx` is the operator-facing control plane.

It reads:

- `bot-identity-config` for saved identities, sidecar path, and credential status;
- `paperclip-agents` for the company-scoped agent dropdown.

The form supports adding, editing, and deleting one provider identity at a time. It prevents duplicate identities for the same agent/provider pair. When agents are available, selecting an agent prefills defaults derived from the agent display name and company, including the label convention `Agent Name [Company Name]`, GitHub App login, commit identity, and private key file path under `/paperclip/.paperclip/agent-identities/github-apps/<agent-id>/private-key.pem`.

The UI also tries to load selectable Paperclip secrets from host REST endpoints for company and user secrets. If company context or secret API access is unavailable, operators can still enter a secret UUID manually.

### Credential propagation

Saving an identity cascades GitHub App environment bindings into that selected agent environment. The browser-side code fetches and patches the selected agent adapter config, preserving unrelated environment variables. Deleting an identity removes only matching bindings for that identity.

Propagated environment names include:

- `GITHUB_APP_ID`
- `GITHUB_INSTALLATION_ID`
- `GITHUB_APP_PRIVATE_KEY` as a Paperclip `secret_ref` object when a secret ID is selected
- or `GITHUB_APP_PRIVATE_KEY_FILE` when using the generated private-key file fallback

This propagation path follows a host REST pattern and is not directly tested by the current Node/Vitest suite.

## GitHub App Manifest flow

The settings UI and worker actions implement GitHub's App Manifest flow.

1. UI calls `create-github-app-manifest` with `agentId`, `label`, `homepageUrl`, and `callbackUrl`.
2. `/src/worker.ts` creates a random state with prefix `pc_`, builds a manifest JSON string, and stores the flow in plugin state under `github-app-manifest-flow:<state>`.
3. The generated manifest includes:
   - private app (`public: false`)
   - callback and setup URLs derived from the settings page URL
   - `setup_on_update: true`
   - `request_oauth_on_install: false`
   - write permissions for `contents`, `pull_requests`, `issues`, and `workflows`
   - `default_events: []`
   - no webhook attributes
4. UI opens/posts to `https://github.com/settings/apps/new?state=<state>`.
5. GitHub redirects back with a one-time `code`.
6. UI calls `convert-github-app-manifest`.
7. Worker exchanges the code through `POST https://api.github.com/app-manifests/{code}/conversions`.
8. Worker requires `id`, `slug`, `name`, and `pem` in the conversion response.
9. Worker writes the PEM to `<credential-sidecar-dir>/github-apps/<agent-id>/private-key.pem` with mode `0600`.
10. Worker returns app ID, app slug, derived GitHub App login `<slug>[bot]`, private key file path, and install URL.
11. UI sends the operator to install the app; GitHub redirects back with `installation_id`.
12. UI restores the flow and pre-fills Installation ID before the operator saves the identity.

Flow state is restored by `get-github-app-manifest-flow` while the operator is returning from GitHub, then deleted after successful manifest conversion so one-time setup state does not accumulate.

## Tests to inspect before changing this domain

- `/tests/identity-policy.spec.ts`: config parsing, missing agent fail-closed behavior, repo normalization, sidecar parsing, token-source precedence, GitHub App token minting.
- `/tests/repo-normalization.spec.ts`: repository reference normalization.
- `/tests/plugin.spec.ts`: settings save/load/delete, sidecar writes/deletes, agent dropdown data, provider-aware settings fallback, GitHub App manifest creation/conversion, and propagation ID dedupe.

## Change guidance

When changing this domain:

- Keep `/src/shared/types.ts`, `/src/config-source.ts`, `/src/worker.ts`, and `/src/ui/SettingsPage.tsx` in sync.
- Preserve fail-closed behavior for missing agent identity and malformed repository inputs.
- Validate and normalize repository inputs before credential resolution.
- Never add generated installation tokens to plugin state or tool outputs.
- Add tests for provider normalization behavior whenever changing config shape.
- Be careful with UI-only host REST behavior because it may need manual validation beyond the existing Node tests.
