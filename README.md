# Agent Identities

Per-agent identity providers and contribution tools for Paperclip. GitHub is the first provider.

## Features

- Configure one identity per Paperclip agent and provider pair.
- Choose from a provider registry: GitHub is enabled now; Slack, Mattermost, Microsoft Entra, Google Cloud, and AWS are tracked as coming soon.
- Prevent duplicate identities for the same agent/provider pair.
- Leave repository/resource access decisions to provider permissions such as GitHub App installations and scopes.
- Create GitHub Apps with GitHub's App Manifest flow from the settings page.
- Store public identity metadata in plugin state, credential references in a local sidecar file, and GitHub App bindings in the selected agent environment.
- Mint short-lived GitHub App installation tokens on demand for provider-specific tools.

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .
pnpm docs:dev       # preview OpenWiki docs with VitePress
```

`pnpm dev` rebuilds the worker, manifest, and UI bundles into `dist/`.
When this package is installed from a local path, Paperclip watches that rebuilt
output and reloads the plugin worker. Local installs run trusted code from this
folder on your machine.

## Install Into Paperclip

```bash
pnpm build
paperclipai plugin install . --local
```

## Identity Config Model

Agent Identities uses a provider-aware settings state. Each saved identity is keyed by `agentId + provider`, using the identity key format `${agentId}:${provider}`. The settings page stores a version 3 map in Paperclip plugin state:

```ts
{
  version: 3,
  identities: Record<`${agentId}:${provider}`, AgentIdentityConfig>
}
```

Core fields:

- `id`: stable identity key, for example `agent-123:github`
- `agentId`: Paperclip agent ID
- `provider`: provider ID such as `github`
- `label`: human-facing label, conventionally `Agent Name [Company Name]`
- `githubUsername`: GitHub App login for GitHub identities, commonly `<app-slug>[bot]`
- Optional `commitName` and `commitEmail`

GitHub tools currently consume only `provider: "github"` identities. At runtime, version 3 settings are filtered to GitHub and projected into the GitHub tool config by `agentId`; the durable settings/sidecar model remains provider-aware. Repository access is controlled by GitHub App installation permissions, scopes, and GitHub API responses, not by Agent Identities.

### Supported providers

| Provider | Status | Notes |
| --- | --- | --- |
| GitHub | Enabled | GitHub App identity for repositories, pull requests, branch pushes, and commit attribution. |
| Slack | Coming soon | Workspace identity for Slack messages and app-mediated actions. |
| Mattermost | Coming soon | Team identity for posts and channel operations. |
| Microsoft Entra | Coming soon | Directory identity for Microsoft Graph and Azure-backed workflows. |
| Google Cloud | Coming soon | Service account identity for Google Cloud APIs. |
| AWS | Coming soon | IAM-backed identity for AWS APIs. |

### GitHub App credentials

The settings page stores public identity metadata in plugin state, writes credential references to an operator-local sidecar file for the plugin worker, and cascades GitHub App bindings into the selected agent environment. Prefer GitHub App credentials so tools mint short-lived installation tokens just in time instead of reading generated token files:

```json
{
  "version": 1,
  "identities": {
    "<agent-id>:github": {
      "githubApp": {
        "appId": "<github-app-id>",
        "installationId": "<github-installation-id>",
        "privateKeySecretId": "<paperclip-company-secret-uuid-containing-private-key>",
        "privateKeyFile": "/paperclip/.paperclip/agent-identities/github-apps/<agent>/private-key.pem"
      }
    }
  }
}
```

Default sidecar path in Paperclip: `/paperclip/.paperclip/agent-identities/credentials.json`. Override with `PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS` for tests or custom deployments. The plugin worker reads this sidecar when its GitHub provider tools need credentials. The saved agent environment receives `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and either `GITHUB_APP_PRIVATE_KEY` as a Paperclip secret reference or `GITHUB_APP_PRIVATE_KEY_FILE` as a private-key file path. The plugin tries the configured private-key secret first and falls back to `privateKeyFile` when a file path is present. It uses those GitHub App credentials to mint a fresh installation token on each GitHub tool call; generated tokens are not stored.

The settings page includes a **Create GitHub App on GitHub** button for bootstrapping this credential source with GitHub's App Manifest flow. The generated manifest opens GitHub with the required permissions (`contents`, `pull_requests`, `issues`, and `workflows` as `write`), marks the app private, uses the selected agent dashboard as the GitHub App homepage, redirects back to the current settings URL for manifest conversion, configures a GitHub App `setup_url` plus `setup_on_update` for post-install and repository-selection callbacks, explicitly disables OAuth-on-install, and intentionally omits `hook_attributes` for the no-webhook case; GitHub rejects `hook_attributes: { "active": false }` even though the resulting error says the URL is missing. After GitHub creates the app, the callback returns to the settings page and restores the relevant identity form with the one-time code prefilled; if the browser loses that state, paste the returned callback URL or `code=...` value into the field manually. The plugin exchanges that one-time code, writes the returned PEM content to `github-apps/<agent-id>/private-key.pem` beside the sidecar credentials file, prefills the App ID, private key file, and GitHub App login fields, then sends the browser into the GitHub App installation flow. GitHub redirects back to the setup URL with `installation_id`, and the settings page restores the same form with Installation ID prefilled before saving. The generated private key file is the automatic credential source. Operators can also copy that PEM into a Paperclip secret and select its UUID to prefer secret resolution over the file fallback. When editing an agent that already has GitHub App credentials, the manifest creation CTA is treated as a replacement/rotation flow and is tucked behind a disclosure so normal edits focus on the existing App ID, Installation ID, and key source.

Saving a GitHub identity patches the selected agent environment with the GitHub App bindings:

```json
{
  "adapterConfig": {
    "env": {
      "GITHUB_APP_ID": "<github-app-id>",
      "GITHUB_INSTALLATION_ID": "<github-installation-id>",
      "GITHUB_APP_PRIVATE_KEY": {
        "type": "secret_ref",
        "secretId": "<paperclip-company-secret-uuid-containing-private-key>",
        "version": "latest"
      }
    }
  }
}
```

Deleting an identity removes only matching GitHub App env bindings for that identity, preserving unrelated environment variables. `secretId`/`tokenFile` token fallback is still accepted, but GitHub App mode is the durable path.

## Documentation site

OpenWiki-generated Markdown lives in [`openwiki/`](openwiki/quickstart.md). The repository publishes that content as a searchable VitePress site through GitHub Pages without moving OpenWiki's source folder.

```bash
pnpm docs:dev       # local VitePress server for openwiki/
pnpm docs:build     # static site output in openwiki/.vitepress/dist
pnpm docs:preview   # preview the built static site
```

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

## CI

GitHub Actions workflows: [CI](.github/workflows/ci.yml), [Release](.github/workflows/release.yml), [Publish](.github/workflows/publish.yml), and [Publish Docs](.github/workflows/pages.yml)

Runs on pull requests and pushes to `main`:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm pack --pack-destination .`
- Uploads `*.tgz` as workflow artifact `npm-package-tarball`

### Releases

Every qualifying push to `main` creates a release pull request for the next stable patch version. It updates `package.json`, `pnpm-lock.yaml`, and `src/manifest.ts` together, validates the package, waits for the automatic Copilot review to finish with zero open threads and for all checks to pass, then squash-merges the release PR through the repository ruleset. Only then does it tag the merged commit, create a GitHub Release, and dispatch npm publication of that immutable tag. If Copilot leaves feedback or a check fails, the release PR remains open for remediation and no tag or publication occurs.

Minor and major releases are manual only. Run **Create Release** from GitHub Actions and choose `minor` or `major`. Real npm publication accepts only a stable `v<major>.<minor>.<patch>` tag whose version exactly matches `package.json`; dispatch **Publish** with `dry_run: true` to validate a tag without publishing. `NPM_TOKEN` must be configured as a repository secret.

Run the same validation locally:

```bash
corepack enable
corepack prepare pnpm@10.17.1 --activate
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .
```

Inspect package contents locally:

```bash
TARBALL="$(ls -t ./*.tgz | head -n1)"
tar -tzf "$TARBALL"
```

Download CI artifact from GitHub:

1. Open the workflow run in the Actions tab.
2. In the `Artifacts` section, download `npm-package-tarball`.
3. Extract the `.tgz` and verify `dist/manifest.js`, `dist/worker.js`, and `dist/ui/index.js` are present.

## Adding a provider

The plugin composes identity providers behind a single `IdentityProvider` contract (`src/core/provider-contract.ts`). Neither `src/worker.ts` nor `src/manifest.ts` reference any specific provider — both consume whatever the registry in `src/providers/index.ts` exposes. Adding a new provider does not require editing `worker.ts` or `manifest.ts`.

To add a provider:

1. Create a new module under `src/providers/<id>/` that implements `IdentityProvider<TIdentity, TRef>`.
2. Write `validateConfig` to parse a single projected identity and return either the typed identity or a joined error string (see `validateGitHubConfig` in `src/providers/github/index.ts` for the pattern).
3. Project raw settings-state identities for your provider's key (`${agentId}:<id>`) into that typed identity shape.
4. Implement credential resolution (`resolveCredential`) — resolve secrets/tokens just in time, never eagerly, and never before params/identity/resource-ref have been validated.
5. Provide `tools`: an array of `ProviderToolSpec` entries, each declaring its metadata, whether it requires a credential, and its `perform` implementation.
6. Optionally contribute `actions` (e.g. an App-manifest-style setup flow) if the provider needs additional worker actions beyond tool calls.
7. Include `manifestTools`: the manifest-facing fragments the composed manifest consumes (see `src/providers/github/manifest-tools.ts`).
8. Append the new provider exactly once, in `src/providers/index.ts`'s `ALL_PROVIDERS` array. This is the single composition root; nothing else needs to change to register it.
9. Add contract tests (validate/project/resolveCredential) and pipeline tests (tool execution through `createProviderTool`) alongside the existing provider test suites, and extend `tests/provider-composition.spec.ts` if the new provider changes composed output.

`worker.ts` and `manifest.ts` are not edited when adding a provider — they only depend on the provider contract and the registry, not on any concrete provider module.

### Security order (all provider tools)

Every credentialed tool call runs through the shared pipeline in `src/core/tool-pipeline.ts` in this fixed order:

1. **Validate params** — deny malformed input before any secret work.
2. **Resolve identity** — fail closed on any error.
3. **Resolve resource ref** — derive/validate the target and deny disallowed targets before a credential exists.
4. **Resolve credentials** — the first point secret material is touched, only after all prior denials.
5. **Perform** — the only provider-specific API/git step.
6. **Redact** — strip the resolved token and any other secrets from the tool result before it is returned.

Provider authors implement steps 1, 3 (optional), 4, and 5; the pipeline enforces the ordering and step 6.
