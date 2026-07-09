# Agent Identities

Per-agent identity providers and contribution tools for Paperclip. GitHub is the first provider.

## Features

- Configure one GitHub identity per Paperclip agent.
- Restrict each identity to explicit `owner/repo` allow-list patterns.
- Create GitHub Apps with GitHub's App Manifest flow from the settings page.
- Store GitHub App metadata in plugin state, credential references in a local sidecar file, and GitHub App bindings in the selected agent environment.
- Mint short-lived GitHub App installation tokens on demand for plugin tools.
- Create pull requests and push branches using the configured agent identity.

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

This repository defines a typed per-agent identity configuration core. The settings page stores a v2 list of agent mappings in plugin state and supports adding, editing, and deleting mappings one agent at a time:

- `identities[agentId].label`
- `identities[agentId].githubUsername`
- `identities[agentId].allowedRepoPatterns` (defaults to `["*/*"]`; supports patterns like `my-org/*` or `my-org/my-repo`)
- Optional `identities[agentId].commitName`
- Optional `identities[agentId].commitEmail`

The worker still reads older single-agent settings state and converts previous `allowedOwnerPattern` / `allowedRepos` values into unified repository patterns at runtime. Repository policy is enforced against the configured `owner/repo` patterns before credentials are resolved.

### GitHub App credentials

The settings page stores public GitHub identity metadata in plugin state, writes credential references to an operator-local sidecar file for the plugin worker, and cascades GitHub App bindings into the selected agent environment. Prefer GitHub App credentials so tools mint short-lived installation tokens just-in-time instead of reading generated token files:

```json
{
  "version": 1,
  "identities": {
    "<agent-id>": {
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

Default sidecar path in Paperclip: `/paperclip/.paperclip/agent-identities/credentials.json`. Override with `PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS` for tests or custom deployments. If the renamed default file is absent but the legacy `/paperclip/.paperclip/github-bot-identity/credentials.json` sidecar exists, the worker reads and updates the legacy file so existing installations keep their saved GitHub App settings. The plugin worker reads this sidecar when its own GitHub tools need credentials. The saved agent environment receives `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and either `GITHUB_APP_PRIVATE_KEY` as a Paperclip secret reference or `GITHUB_APP_PRIVATE_KEY_FILE` as a private-key file path. The plugin tries the configured private-key secret first and falls back to `privateKeyFile` when a file path is present. It uses those GitHub App credentials to mint a fresh installation token on each GitHub tool call; generated tokens are not stored.

The settings page includes a **Create GitHub App on GitHub** button for bootstrapping this credential source with GitHub's App Manifest flow. The generated manifest opens GitHub with the required permissions (`contents`, `pull_requests`, `issues`, and `workflows` as `write`), marks the app private, uses the selected agent dashboard as the GitHub App homepage, redirects back to the current settings URL for manifest conversion, configures a GitHub App `setup_url` plus `setup_on_update` for post-install and repository-selection callbacks, explicitly disables OAuth-on-install, and intentionally omits `hook_attributes` for the no-webhook case; GitHub rejects `hook_attributes: { "active": false }` even though the resulting error says the URL is missing. After GitHub creates the app, the callback returns to the settings page and restores the relevant identity form with the one-time code prefilled; if the browser loses that state, paste the returned callback URL or `code=...` value into the field manually. The plugin exchanges that one-time code, writes the returned PEM content to `github-apps/<agent-id>/private-key.pem` beside the sidecar credentials file, prefills the App ID, private key file, and bot username fields, then sends the browser into the GitHub App installation flow. GitHub redirects back to the setup URL with `installation_id`, and the settings page restores the same form with Installation ID prefilled before saving. The generated private key file is the automatic credential source. Operators can also copy that PEM into a Paperclip secret and select its UUID to prefer secret resolution over the file fallback. When editing an agent that already has GitHub App credentials, the manifest creation CTA is treated as a replacement/rotation flow and is tucked behind a disclosure so normal edits focus on the existing App ID, Installation ID, and key source.

Saving an identity patches the selected agent environment with the GitHub App bindings:

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

GitHub Actions workflows: [CI](.github/workflows/ci.yml) and [Publish Docs](.github/workflows/pages.yml)

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
