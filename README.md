# GitHub Bot Identity

Per-agent GitHub bot identity and contribution tools for Paperclip

## Development

```bash
pnpm install
pnpm dev            # watch builds
pnpm dev:ui         # local dev server with hot-reload events
pnpm test
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

The worker now includes a typed per-agent identity configuration core:

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
