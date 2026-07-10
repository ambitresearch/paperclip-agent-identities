# Agent identity domain

## Core model

The canonical v4 identity and settings-state types live in `/src/core/identity-config.ts`; `/src/shared/types.ts` re-exports them as `BotIdentityConfig` / `BotIdentitySettingsState` for the UI and worker action payloads.

`AgentIdentityConfig` is a discriminated union keyed on `provider`. Each variant nests its provider-specific fields under a field named after the provider, so `GitHubAgentIdentityConfig` carries a `github` object rather than flat `github*` properties:

```ts
type GitHubAgentIdentityConfig = {
  provider: "github";
  id: string;       // `${agentId}:${provider}`
  agentId: string;
  label: string;
  github: {
    username: string;                 // GitHub App login, commonly `<app-slug>[bot]`
    commitName?: string;
    commitEmail?: string;
    app?: { credentialPropagationAgentIds?: readonly string[] };
  };
};
```

- `id`: stable identity key, for example `agent-123:github`.
- `agentId`: Paperclip agent ID.
- `provider`: identity provider ID. GitHub is enabled today; Slack, Mattermost, Microsoft Entra, Google Cloud, and AWS are listed as coming soon.
- `label`: human-readable name shown in settings and tool output. The UI convention is `Agent Name [Company Name]`.
- `github.username` / `github.commitName` / `github.commitEmail` / `github.app.credentialPropagationAgentIds`: nested GitHub-specific fields — never accessed as top-level `githubUsername`/`commitName`/etc. anywhere past the persistence boundary.

Settings state is versioned (`BOT_IDENTITY_SETTINGS_VERSION`, currently `4`):

```ts
{
  version: 4,
  identities: Record<`${agentId}:${provider}`, AgentIdentityConfig>
}
```

`normalizeSettingsState()` in `/src/core/identity-config.ts` is the only place that reads persisted state: v4 payloads pass through, v3 payloads (flat `githubUsername`/`commitName`/etc.) are migrated forward into nested `github.*` shape via `migrateSettingsStateToV4()`, and anything else resets to an empty v4 state. There is no v3 runtime read/write path anymore — `/src/worker.ts` and `/src/config-source.ts` only ever produce and consume v4.

The worker stores this under `CONFIG_SCOPE` from `/src/config-source.ts`: `{ scopeKind: "instance", stateKey: "bot-identity-config" }`. `config-source.ts` is now just that constant — the old flat-shape resolver (`resolveAgentIdentityFromPluginSettings` / `normalizeBotIdentitySettingsState`) was superseded by the generic per-provider resolver in `/src/worker.ts` (`resolveIdentityForProvider`), which asks each registered `IdentityProvider` to project this same v4 `identities` map into its own config shape (see `plugin-runtime.md`).

## Provider authorization

Agent Identities does not implement repository/resource authorization. It maps agents to provider identities and credentials, then lets the provider enforce access through installation permissions, scopes, provider APIs, and tool-specific responses.

`/src/providers/github/config.ts` and `/src/providers/github/repo-ref.ts` are used by the GitHub provider's runtime tools. They:

- parse plugin config with a zod schema (`githubIdentitySchema`);
- resolve the calling `runContext.agentId` to the GitHub provider identity projected as `identities[agentId]`;
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

`/src/config-source.ts` now only exports `CONFIG_STATE_KEY` / `CONFIG_SCOPE`. Bridging static (instance) config and settings-page state is a worker-level, provider-agnostic concern implemented by `resolveIdentityForProvider()` in `/src/worker.ts`:

1. calls `ctx.config.get()` and asks the provider (`provider.validateConfig`) to validate the per-agent instance config;
2. if that fails and settings-page state (`CONFIG_SCOPE`) exists, normalizes it with `normalizeSettingsState()` (v4, migrating v3 automatically) and asks the provider to project its `identities` map (`provider.projectPluginConfig`) before resolving through `resolveAgentIdentity()`;
3. if both fail, throws an error containing the primary and fallback reasons.

Because settings-page state is always v4, every provider's `projectPluginConfig` receives the nested `AgentIdentityConfig` union and is responsible for narrowing to its own provider and reading its own nested fields (e.g. `identity.github.username` for GitHub). Disabled or unknown provider records are ignored during projection. The current settings UI cascades GitHub App credentials to the selected agent identity.

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

- `/tests/identity-config-migration.spec.ts`: v3 -> v4 settings-state migration ladder.
- `/tests/github-config.spec.ts` / `/tests/github-project-config.spec.ts`: GitHub plugin config parsing, missing-agent fail-closed behavior, and v4 identity projection.
- `/tests/github-repo-ref.spec.ts`: repository reference normalization.
- `/tests/plugin.spec.ts`: settings save/load/delete against v4 nested state, sidecar writes/deletes, agent dropdown data, provider-aware settings fallback, GitHub App manifest creation/conversion, and propagation ID dedupe.

## Change guidance

When changing this domain:

- Keep `/src/core/identity-config.ts`, `/src/shared/types.ts`, `/src/config-source.ts`, `/src/worker.ts`, and `/src/ui/SettingsPage.tsx` in sync.
- Persisted state is v4 nested `github.*`/`example.*` fields only — never reintroduce a flat top-level `githubUsername`/`commitName`/`commitEmail` read/write path. New providers append a variant to `AgentIdentityConfig`, not new top-level fields.
- Preserve fail-closed behavior for missing agent identity and malformed repository inputs.
- Validate and normalize repository inputs before credential resolution.
- Never add generated installation tokens to plugin state or tool outputs.
- Add tests for provider normalization behavior whenever changing config shape.
- Be careful with UI-only host REST behavior because it may need manual validation beyond the existing Node tests.
