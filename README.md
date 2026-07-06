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
- `identities[agentId].allowedOwnerPatterns` (defaults to `["^roshangautam$"]`)
- Optional `identities[agentId].allowedRepos`
- Optional `identities[agentId].commitName`
- Optional `identities[agentId].commitEmail`

MVP repo policy hard-denies any repository outside `roshangautam/*`, even if other patterns are configured.

### Credential sidecar workaround

Current Paperclip server builds reject plugin config fields that look like secret references until company-scoped plugin config lands. Keep plugin config free of secrets and bind credentials through an operator-managed sidecar file instead:

```json
{
  "version": 1,
  "identities": {
    "<agent-id>": {
      "secretId": "<paperclip-company-secret-uuid>",
      "tokenFile": "/paperclip/.paperclip/github-bot-identity/tokens/<agent-id>.token"
    }
  }
}
```

Default path in Paperclip: `/paperclip/.paperclip/github-bot-identity/credentials.json`. Override with `PAPERCLIP_GITHUB_BOT_IDENTITY_CREDENTIALS` for tests or custom deployments. If both fields are present, the plugin tries `secretId` first and falls back to `tokenFile` only when Paperclip plugin secret resolution fails. Prefer `secretId` once Paperclip plugin secret resolution is enabled. Until then, set `tokenFile` to an operator-managed file containing the GitHub token; keep that file outside git, readable only by the Paperclip server user, and remove it after migrating back to `secretId`.

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
paperclipai plugin install @gautamroshan/paperclip-github-bot-identity@<version>
```
