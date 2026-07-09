# Plugin runtime architecture

## Build and package entrypoints

This is a Paperclip plugin package. `/package.json` declares the package as ESM, exposes the built plugin artifacts through the `paperclipPlugin` field, and provides the main scripts:

- `pnpm build` runs `/esbuild.config.mjs`.
- `pnpm dev` runs the same build in watch mode.
- `pnpm dev:ui` serves built UI files through `paperclip-plugin-dev-server`.
- `pnpm typecheck` and `pnpm test` validate TypeScript and Vitest tests.

`/esbuild.config.mjs` uses `createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" })` from `@paperclipai/plugin-sdk/bundlers` and rebuilds the worker, manifest, and UI bundles. `/rollup.config.mjs` is an alternate build path using SDK Rollup presets.

Do not edit generated `/dist` files directly; change `/src` and rebuild.

## Manifest contract

`/src/manifest.ts` is the static Paperclip manifest source. It currently declares:

- plugin ID: `roshangautam.paperclip-agent-identities`
- display name: `Agent Identities`
- version: `0.1.3`
- category: `connector`
- entrypoints: `./dist/worker.js` and `./dist/ui`

Important capabilities include:

- `plugin.state.read` / `plugin.state.write` for settings state and GitHub App manifest flow state
- `instance.settings.register` and `ui.dashboardWidget.register` for the UI slots
- `agent.tools.register` for the GitHub tools
- `agents.read` for populating the settings-page agent dropdown
- `http.outbound` for GitHub API and host REST calls
- `secrets.read-ref` for Paperclip secret resolution
- `activity.log.write` for PR/push audit events
- `project.workspaces.read` for mediated git push workspace resolution

The manifest declares three tools using metadata from shared tool-definition files:

- `github_bot_whoami`
- `github_bot_create_pull_request`
- `github_bot_push_branch`

It also declares two UI slots:

- `DashboardWidget` as dashboard widget `health-widget`
- `SettingsPage` as settings page `bot-identity-settings`

`/tests/plugin.spec.ts` checks key manifest capabilities and the settings page slot.

## Worker setup

`/src/worker.ts` defines the runtime plugin with `definePlugin()` and launches it with `runWorker(plugin, import.meta.url)`.

During `setup(ctx)`, the worker registers:

### Event handler

- `issue.created`: writes `{ scopeKind: "issue", scopeId: issueId, stateKey: "seen" } = true` and logs the event.

This is scaffold-like behavior but is covered by `/tests/plugin.spec.ts`.

### Data loaders

- `health`: returns `{ status: "ok", checkedAt }`.
- `bot-identity-config`: normalizes settings state from `CONFIG_SCOPE`, reads the credential sidecar if available, and returns sorted identity entries plus credential status.
- `paperclip-agents`: requires a `companyId`, calls `ctx.agents.list({ companyId })`, maps agents into dropdown options, and sorts by name.

### Actions

- `ping`: simple health/debug action.
- `save-bot-identity-config`: validates and normalizes provider-aware identity input, stores version-3 settings state under `CONFIG_SCOPE`, and upserts/deletes sidecar credential references when a `credential` field is supplied.
- `delete-bot-identity-config`: removes one identity from settings state and deletes its sidecar entry.
- `create-github-app-manifest`: creates and stores a GitHub App manifest-flow state object.
- `get-github-app-manifest-flow`: restores a stored manifest flow by state token.
- `convert-github-app-manifest`: exchanges a GitHub manifest one-time code for app metadata and PEM, persists the private key file, and stores the conversion result in flow state.

### Tools

- `github_bot_push_branch` is registered from `/src/github-bot-push-branch.ts`.
- `github_bot_whoami` is registered inline in `/src/worker.ts`.
- `github_bot_create_pull_request` is registered by `/src/tools/create-pull-request.ts`.

## Config and state sources

There are two identity configuration paths:

1. **Plugin instance config** via `ctx.config.get()`.
2. **Settings-page state fallback** under `CONFIG_SCOPE`, defined in `/src/config-source.ts` as `{ scopeKind: "instance", stateKey: "bot-identity-config" }`.

`resolveAgentIdentityFromPluginSettings()` tries instance config first. If that fails and settings state exists, it normalizes settings state into the same config shape and tries again. This fallback was added so tools can use identities saved by the settings page rather than only static instance config.

Settings state is normalized to version 3 provider-aware records:

```ts
{
  version: 3,
  identities: Record<`${agentId}:${provider}`, AgentIdentityConfig>
}
```

GitHub tools filter settings state to `provider: "github"` and project it into their runtime config by `agentId`. Older settings-state shapes are not preserved in the current greenfield model.

## UI architecture

`/src/ui/index.tsx` exports:

- `DashboardWidget`: reads `bot-identity-config` and summarizes total identities, complete GitHub App identities, and identities needing setup.
- `SettingsPage`: re-exported from `/src/ui/SettingsPage.tsx`.

The settings page uses Paperclip UI SDK hooks to read data loaders and invoke worker actions. It also performs browser-side host API calls for secret options and GitHub App credential propagation to the selected agent environment. Those browser-side propagation calls are not directly covered by the current Node test suite, so changes there need extra manual or UI-focused validation.

## Health and operational shape

The worker has both a registered `health` data loader and an `onHealth()` hook returning `{ status: "ok", message: "Plugin worker is running" }`.

Activity logging is part of the contribution-tool flow rather than a global middleware:

- PR creation logs a `pull_request` entity with PR metadata.
- Push branch logs a `run` entity with branch, remote, repository, outcome, and dry-run status when applicable.

## Change guidance

When changing runtime contracts:

- Update `/src/manifest.ts` when adding capabilities, tools, or UI slots.
- Update shared tool metadata files and worker registration together.
- Keep `/src/shared/types.ts` aligned with UI form data, worker actions, and tests.
- If adding state, choose a scoped state key deliberately and document the current state contract.
- Run `pnpm typecheck` and `pnpm test`; run `pnpm build` when entrypoints or bundling change.
