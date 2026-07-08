# Paperclip Agent Identities

Per-agent identity providers and contribution tools for Paperclip. GitHub is the first provider.

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .
```

`pnpm dev` rebuilds the worker, manifest, and UI bundles into `dist/`.
When this package is installed from a local path, Paperclip watches that rebuilt
output and reloads the plugin worker. Local installs run trusted code from this
folder on your machine.



## Install Into Paperclip

```bash
paperclipai plugin install @gautamroshan/paperclip-agent-identities
```

## Identity Config Model

This repository defines a typed per-agent identity configuration core. The settings page stores a v2 list of agent mappings in plugin state and supports adding, editing, and deleting mappings one agent at a time:

- `identities[agentId].label`
- `identities[agentId].githubUsername`
- `identities[agentId].allowedRepoPatterns` (defaults to `["roshangautam/*"]`; supports patterns like `codestudiohq/laravel-totem`)
- Optional `identities[agentId].githubAppCredentialPropagationAgentIds`
- Optional `identities[agentId].commitName`
- Optional `identities[agentId].commitEmail`

The worker still reads older single-agent settings state and converts previous `allowedOwnerPattern` / `allowedRepos` values into unified repository patterns at runtime. Repository policy is enforced against the configured `owner/repo` patterns before credentials are resolved.

### GitHub App credential workaround

Current Paperclip server builds reject plugin config fields that look like secret references until company-scoped plugin config lands. The settings page stores public GitHub identity metadata in plugin state and writes credential references to an operator-local sidecar file. Prefer GitHub App credentials so tools mint short-lived installation tokens just-in-time instead of reading generated token files:

```json
{
  "version": 1,
  "identities": {
    "<agent-id>": {
      "githubApp": {
        "appId": "<github-app-id>",
        "installationId": "<github-installation-id>",
        "privateKeySecretId": "<paperclip-company-secret-uuid-containing-private-key>",
        "privateKeyFile": "/paperclip/.paperclip/github-bot-identity/github-apps/<agent>/private-key.pem"
      }
    }
  }
}
```

Default path in Paperclip: `/paperclip/.paperclip/github-bot-identity/credentials.json`. Override with `PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS` for tests or custom deployments; `PAPERCLIP_GITHUB_BOT_IDENTITY_CREDENTIALS` is still accepted for compatibility. The plugin tries the private-key secret first and falls back to `privateKeyFile` while plugin secret refs are disabled. It uses those GitHub App credentials to mint a fresh installation token on each GitHub tool call; generated tokens are not stored.

The settings page includes a **Create GitHub App on GitHub** button for bootstrapping this credential source with GitHub's App Manifest flow. The generated manifest opens GitHub with the required permissions (`contents`, `pull_requests`, `issues`, and `workflows` as `write`), marks the app private, redirects back to the current settings URL, and intentionally omits `hook_attributes` for the no-webhook case; GitHub rejects `hook_attributes: { "active": false }` even though the resulting error says the URL is missing. After GitHub creates the app, the callback returns to the settings page and restores the relevant identity form with the one-time code prefilled; if the browser loses that state, paste the returned callback URL or `code=...` value into the field manually. The plugin exchanges that one-time code, writes the returned PEM to `github-apps/<agent-id>/private-key.pem` beside the sidecar credentials file, and prefills the App ID, private key file, and bot username fields. Operators still install the app on the target account/repositories and paste the Installation ID before saving. When editing an agent that already has GitHub App credentials, the manifest creation CTA is treated as a replacement/rotation flow and is tucked behind a disclosure so normal edits focus on the existing App ID, Installation ID, and key source.

The settings page can also propagate GitHub App credentials to one or more agent environments, matching the GitHub Sync plugin's host REST patch pattern:

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

Removing an agent from `githubAppCredentialPropagationAgentIds` removes only matching GitHub App env bindings for that identity, preserving unrelated environment variables. `secretId`/`tokenFile` token fallback is still accepted, but GitHub App mode is the durable path.

### TrueNAS dev deploy

The active TrueNAS test plugin is registered as the dev-dropdown variant and points at a symlinked server-side directory:

- Registered path: `/paperclip/.paperclip/github-bot-identity/dev-dropdown-plugin-fallback-20260706-062302`
- Symlink target: `/paperclip/.paperclip/github-bot-identity/dev-sync-live`

After local edits, run:

```sh
pnpm deploy:truenas
```

The script builds locally, stages `dist`, `README.md`, `pnpm-lock.yaml`, and `package.json`, rewrites the staged manifest/package identity to the registered dev-dropdown plugin id, and rsyncs it to TrueNAS. The default dev manifest id intentionally remains the existing GitHub-specific registration id so the live test plugin keeps its current state while showing the new Paperclip Agent Identities branding. Paperclip's local plugin watcher reloads the worker/UI from that path.

Override the defaults with `PAPERCLIP_TRUENAS_HOST`, `PAPERCLIP_AGENT_IDENTITIES_PLUGIN_PATH`, `PAPERCLIP_AGENT_IDENTITIES_DEV_MANIFEST_ID`, `PAPERCLIP_AGENT_IDENTITIES_DEV_PACKAGE_NAME`, or `PAPERCLIP_AGENT_IDENTITIES_DEV_VERSION`. The older `PAPERCLIP_GITHUB_BOT_*` names are still accepted for compatibility.

## Build Options

- `pnpm build` uses esbuild presets from `@paperclipai/plugin-sdk/bundlers`.
- `pnpm build:rollup` uses rollup presets from the same SDK.

## CI

GitHub Actions workflow: [`.github/workflows/ci.yml`](.github/workflows/ci.yml)

Runs on pull requests and pushes to `main`:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm pack --pack-destination .`
- Uploads `*.tgz` as workflow artifact `npm-package-tarball`

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

## Publish

GitHub Actions workflow: [`.github/workflows/publish.yml`](.github/workflows/publish.yml)

Publish automation is temporarily disabled because the npm package has been removed. When publishing is restored, use explicit release paths:

- Recommended: merge a PR to `main` that bumps `package.json` by major, minor,
  or patch. The `Create Release` workflow validates the package, creates the
  `v<package.json version>` GitHub Release, then dispatches the `Publish`
  workflow against that tag.
- You can also run `Create Release` manually from Actions for the current
  `package.json` version.
- Manually publishing a GitHub Release also triggers the `Publish` workflow.
- Manual `Publish` workflow dispatch supports safe dry-run by default.

Required GitHub secret:

- `NPM_TOKEN`: npm automation token with publish permissions.

Manual dry-run publish in GitHub Actions:

1. Open `Publish` workflow in Actions.
2. Click `Run workflow`.
3. Keep `dry_run=true` to validate publish packaging without uploading to npm.

Create a release and publish to npm automatically:

1. Bump `package.json` version in a PR using a major, minor, or patch increase.
2. Merge the PR to `main`.
3. The `Create Release` workflow runs from the merge commit, creates `v<version>`,
   and dispatches the `Publish` workflow for that tag.

Create a release manually:

1. Open `Create Release` workflow in Actions.
2. Click `Run workflow` from `main`.
3. Leave `version` empty to use `package.json`, or set it to the exact same version.
4. Keep `publish_to_npm=true` to dispatch the `Publish` workflow for the new tag.

Manual real publish in GitHub Actions:

1. Open `Publish` workflow in Actions.
2. Click `Run workflow`.
3. Set `dry_run=false`.
4. Set `ref` to a release tag (for example `v0.1.1`) or leave it empty for `main`.

Test install of a published version in Paperclip:

```bash
paperclipai plugin install @gautamroshan/paperclip-agent-identities@<version>
```
