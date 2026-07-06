# GitHub Bot Identity

Per-agent GitHub bot identity and contribution tools for Paperclip

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
paperclipai plugin install /Users/roshan.gautam/Developer/projects/paperclip-github-bot-identity-plugin
```

## Identity Config Model

This repository defines a typed per-agent identity configuration core:

- `identities[agentId].label`
- `identities[agentId].githubUsername`
- `identities[agentId].tokenSecretRef`
- `identities[agentId].allowedOwnerPatterns` (defaults to `["^roshangautam$"]`)
- Optional `identities[agentId].allowedRepos`
- Optional `identities[agentId].commitName`
- Optional `identities[agentId].commitEmail`

MVP repo policy hard-denies any repository outside `roshangautam/*`, even if other patterns are configured.

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

Publish is only available through explicit release paths:

- Recommended: run the `Create Release` workflow after bumping `package.json`.
  It validates the package, creates the `v<package.json version>` GitHub Release,
  then dispatches the `Publish` workflow against that tag.
- Manually publishing a GitHub Release also triggers the `Publish` workflow.
- Manual `Publish` workflow dispatch supports safe dry-run by default.

Required GitHub secret:

- `NPM_TOKEN`: npm automation token with publish permissions.

Manual dry-run publish in GitHub Actions:

1. Open `Publish` workflow in Actions.
2. Click `Run workflow`.
3. Keep `dry_run=true` to validate publish packaging without uploading to npm.

Create a release and publish to npm:

1. Bump `package.json` version in a PR and merge it to `main`.
2. Open `Create Release` workflow in Actions.
3. Click `Run workflow` from `main`.
4. Leave `version` empty to use `package.json`, or set it to the exact same version.
5. Keep `publish_to_npm=true` to dispatch the `Publish` workflow for the new tag.

Manual real publish in GitHub Actions:

1. Open `Publish` workflow in Actions.
2. Click `Run workflow`.
3. Set `dry_run=false`.
4. Set `ref` to a release tag (for example `v0.1.1`) or leave it empty for `main`.

Test install of a published version in Paperclip:

```bash
paperclipai plugin install @gautamroshan/paperclip-github-bot-identity@<version>
```
