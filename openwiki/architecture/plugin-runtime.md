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
- `agent.sessions.create`, `agent.sessions.list`, `agent.sessions.send`, and `agent.sessions.close` for the Slack inbound
  message reply lifecycle
- `http.outbound` for GitHub API and host REST calls
- `secrets.read-ref` for Paperclip secret resolution
- `activity.log.write` for PR/push audit events
- `project.workspaces.read` for mediated git push workspace resolution

`/src/manifest.ts` sources its tool list from the provider registry rather than importing provider-specific tool definitions directly: it filters every provider's `manifestTools` down to the names present in `registry.liveTools()`. `liveTools()` is a provider-neutral gate distinct from `enabled()`: it returns every tool from a `toolsEnabled()` provider (`definition.toolsStatus ?? definition.status === "enabled"`), PLUS any individual tool a not-yet-`toolsEnabled()` provider marks `live: true` on its `ProviderToolSpec`. This lets a provider ship real, live tools before its full identity/settings-UI surface (`enabled()`) is ready, without adding a provider-specific branch to `/src/manifest.ts` or `/src/worker.ts` — `/src/worker.ts`'s tool-registration loop iterates the same `registry.liveTools()` list. Today `registry.liveTools()` contributes:

- `github_bot_whoami`
- `github_bot_create_pull_request`
- `github_bot_push_branch`
- `slack_bot_whoami` (DRO-972), `slack_bot_post_message` (DRO-973), and `slack_bot_add_reaction`/`slack_bot_remove_reaction` (DRO-974) — Slack is still `status: "coming-soon"` (hidden from the settings-page identity picker) but sets `toolsStatus: "enabled"`, so its whole current tool surface registers in the live worker/manifest now

Adding a new enabled provider, a new `toolsStatus: "enabled"` provider, or new tools on an existing provider changes what the registry returns and does not require touching `/src/manifest.ts` or `/src/worker.ts`. "Enabled" is a provider-level gate (`definition.status === "enabled"`), but it is not the only way a tool reaches the manifest/worker: `registry.liveTools()` also includes any individual tool a still-`"coming-soon"` provider opts in via `ProviderToolSpec.live: true`, independent of a provider-wide `toolsStatus` flip.

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
- `save-bot-identity-config`: validates and normalizes GitHub identity input into a nested v4 `GitHubAgentIdentityConfig` (`github: { username, commitName?, commitEmail?, app? }`), stores v4 settings state (`BOT_IDENTITY_SETTINGS_VERSION`) under `CONFIG_SCOPE`, and upserts/deletes sidecar credential references when a `credential` field is supplied.
- `delete-bot-identity-config`: removes one identity from settings state and deletes its sidecar entry.
- Manifest-flow actions (`create-github-app-manifest`, `get-github-app-manifest-flow`, `convert-github-app-manifest`) are contributed by the GitHub provider's `contributeActions` hook (see below), not registered inline in `/src/worker.ts`.

### Tools and provider registry iteration

`/src/worker.ts` does not register provider tools one-by-one. It builds a provider registry (`createProviderRegistry()` from `/src/providers/index.ts`) and:

- via `registry.liveTools()` (all tools from `toolsEnabled()` providers — providers whose `toolsStatus` is `"enabled"` independent of their settings-UI `status` — plus any individual tool from a not-yet-`toolsEnabled()` provider that opts in via `toolSpec.live: true`), wraps each composed tool through `createProviderTool()` in `/src/core/tool-pipeline.ts`, which enforces the common deny-before-secret pipeline (validate params -> resolve identity -> resolve/deny resource ref -> resolve credential -> perform -> redact secrets), and registers the resulting handler with `ctx.tools.register`. Slack opts its live tool subset in this way via `toolsStatus: "enabled"`: the credential-free `slack_bot_whoami` (DRO-972) and the post/reply tool `slack_bot_post_message` (DRO-973) both reach `ctx.tools.register`/the manifest today, ahead of the rest of the (still `"coming-soon"`) Slack provider's tool surface;
- for **every registered provider, enabled or not** (`registry.all()`), calls the provider's optional `contributeActions(ctx)` hook. This is how the GitHub provider registers its GitHub App manifest actions (`create-github-app-manifest`, `get-github-app-manifest-flow`, `convert-github-app-manifest`) without `/src/worker.ts` importing GitHub-specific action code directly, and it's also why a "coming-soon" provider with no tool surface yet (e.g. Slack) can still ship setup/bootstrap actions ahead of `tools` landing — `contributeActions` is intentionally not gated on `enabled()`.

Concretely, GitHub's tools (`github_bot_whoami`, `github_bot_create_pull_request`, `github_bot_push_branch`) live in `/src/providers/github/tools/*.ts` and are exposed through `githubProvider.tools` in `/src/providers/github/index.ts` — the worker loop is provider-agnostic and would pick up a new provider's tools/actions the same way once it's added to the registry.

### Provider webhooks and Slack sessions

The manifest declares provider webhook endpoints from `registry.webhooks()`, and the worker routes
each delivery to the matching provider handler. Slack's `slack-events` handler verifies the request,
deduplicates it, and routes it by app ID plus team ID. It then uses the SDK's plugin session methods
to reuse one durable agent conversation per Slack DM or thread, send a bounded event prompt, and
collect response chunks. The plugin-state mapping survives worker reloads, while the host session
list lets ingress replace a mapping whose session no longer exists. Different Slack threads and
channels remain isolated from each other.

The agent returns plain text and does not call Slack tools for this path. The provider callback posts
that text through `createProviderTool(slack_bot_post_message)`, preserving the standard validation,
identity, resource, credential, perform, and redaction pipeline. This keeps the integration inside
the plugin SDK boundary and requires no Paperclip core changes.

## Config and state sources

There are two identity configuration paths:

1. **Plugin instance config** via `ctx.config.get()`.
2. **Settings-page state fallback** under `CONFIG_SCOPE`, defined in `/src/config-source.ts` as `{ scopeKind: "instance", stateKey: "bot-identity-config" }`. `/src/config-source.ts` exports only this constant — it does not implement any resolution logic itself.

`resolveIdentityForProvider()` in `/src/worker.ts` is the provider-agnostic resolver every provider tool goes through. It tries instance config first (`provider.validateConfig`). If that fails and settings-page state exists, it normalizes the state with `normalizeSettingsState()` and asks the provider to project the v4 `identities` map into its own identity shape (`provider.projectPluginConfig`) before resolving via `resolveAgentIdentity()`. This fallback lets tools use identities saved by the settings page rather than only static instance config.

Settings state is normalized to version 4 nested provider records (`BOT_IDENTITY_SETTINGS_VERSION` from `/src/core/identity-config.ts`):

```ts
{
  version: 4,
  identities: Record<`${agentId}:${provider}`, AgentIdentityConfig>
}
```

`normalizeSettingsState()` migrates any stored v3 (flat `githubUsername`/`commitName`/etc.) state forward automatically; there is no v3 runtime read/write path. Each provider's `projectPluginConfig` narrows this same v4 map to its own `provider` discriminant and reads its own nested fields (GitHub reads `identity.github.username`, etc.) — the worker loop itself stays provider-agnostic.

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
