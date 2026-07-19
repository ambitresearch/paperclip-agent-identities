---
type: Architecture Document
title: Plugin runtime architecture
description: Describes the Paperclip plugin runtime architecture, including build entrypoints, manifest capabilities, worker setup, provider registry iteration, Slack webhook/session handling, configuration state, UI structure, health checks, and change guidance.
tags: [architecture, plugin-runtime, paperclip, providers, slack, github]
---
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
- `events.subscribe` / `events.emit` for the provider-owned, company-scoped Slack queue-drain self-event
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
- `plugin.roshangautam.paperclip-agent-identities.slack-turn-drain`: contributed
  by Slack through the existing provider `contributeActions(ctx)` setup seam;
  drains at most one persisted conversation turn under fresh company scope.

This is scaffold-like behavior but is covered by `/tests/plugin.spec.ts`.

### Data loaders

- `health`: returns `{ status: "ok", checkedAt }`.
- `bot-identity-config`: normalizes settings state from `CONFIG_SCOPE`, reads the credential sidecar if available, and returns sorted identity entries plus credential status.
- `paperclip-agents`: requires a `companyId`, calls `ctx.agents.list({ companyId })`, maps agents into dropdown options, and sorts by name.

### Actions

- Settings mutations and provider setup actions are human-only. Their handlers first require the SDK-authenticated `PluginPerformActionContext.actor.type` to be `"user"`; a null `userId` remains valid for a local implicit board user, while agent, system, missing, or malformed actor context is rejected before state, config, secret, or HTTP access.
- `ping`: simple health/debug action.
- `save-bot-identity-config`: validates and normalizes GitHub identity input into a nested `GitHubAgentIdentityConfig` (`github: { username, commitName?, commitEmail?, app? }`), stores the current versioned settings state (`BOT_IDENTITY_SETTINGS_VERSION`) under `CONFIG_SCOPE`, and upserts/deletes sidecar credential references when a `credential` field is supplied.
- `delete-bot-identity-config`: removes one identity from settings state and deletes its sidecar entry.
- Manifest-flow actions (`create-github-app-manifest`, `get-github-app-manifest-flow`, `convert-github-app-manifest`) are contributed by the GitHub provider's `contributeActions` hook (see below), not registered inline in `/src/worker.ts`.

### Tools and provider registry iteration

`/src/worker.ts` does not register provider tools one-by-one. It builds a provider registry (`createProviderRegistry()` from `/src/providers/index.ts`) and:

- via `registry.liveTools()` (all tools from `toolsEnabled()` providers — providers whose `toolsStatus` is `"enabled"` independent of their settings-UI `status` — plus any individual tool from a not-yet-`toolsEnabled()` provider that opts in via `toolSpec.live: true`), wraps each composed tool through `createProviderTool()` in `/src/core/tool-pipeline.ts`, which enforces the common deny-before-secret pipeline (validate params -> resolve identity -> resolve/deny resource ref -> resolve credential -> perform -> redact secrets), and registers the resulting handler with `ctx.tools.register`. Slack opts its live tool subset in this way via `toolsStatus: "enabled"`: the credential-free `slack_bot_whoami` (DRO-972) and the post/reply tool `slack_bot_post_message` (DRO-973) both reach `ctx.tools.register`/the manifest today, ahead of the rest of the (still `"coming-soon"`) Slack provider's tool surface;
- for **every registered provider, enabled or not** (`registry.all()`), calls the provider's optional `contributeActions(ctx)` hook. This is how the GitHub provider registers its GitHub App manifest actions (`create-github-app-manifest`, `get-github-app-manifest-flow`, `convert-github-app-manifest`) without `/src/worker.ts` importing GitHub-specific action code directly, and it's also why a "coming-soon" provider with no tool surface yet (e.g. Slack) can still ship setup/bootstrap actions ahead of `tools` landing — `contributeActions` is intentionally not gated on `enabled()`.

The hook name is historical: it is the existing provider setup seam and may
also register provider-owned event handlers. Slack composes its single queue
drain self-event there; the worker still contains no Slack-specific branch.

Concretely, GitHub's tools (`github_bot_whoami`, `github_bot_create_pull_request`, `github_bot_push_branch`) live in `/src/providers/github/tools/*.ts` and are exposed through `githubProvider.tools` in `/src/providers/github/index.ts` — the worker loop is provider-agnostic and would pick up a new provider's tools/actions the same way once it's added to the registry.

### Provider webhooks and Slack sessions

The manifest declares provider webhook endpoints from `registry.webhooks()`, and the worker routes
each delivery to the matching provider handler. Slack's `slack-events` handler verifies the request,
routes it by app ID plus team ID, and persists a bounded turn in one version-2 per-conversation state
record. That record owns the reusable session mapping, ordered pending turns, active/accepted/uncertain
phase, and completed event hashes retained for 24 hours from completion. The webhook then awaits a
company-scoped `slack-turn-drain` emit and returns HTTP 200; it does not call session APIs or wait for
an earlier run.

Slack contributes one self-event handler through its provider setup hook. A fresh event invocation
drains at most one queued turn, resolves/reuses the conversation session, and calls `sendMessage`.
The callback is bound to the persisted accepted `runId`; pre-result events are buffered, stale events
are ignored, and terminal handling awaits reply finalization before completing the event claim,
clearing active state, and kicking the FIFO successor. There is no detached timer that calls the host:
the 30-minute accepted lease is retired only by a later fresh webhook/self-event; the accepted
session callback finalizes its own run.
Different Slack threads and channels remain isolated; DMs intentionally share one conversation.

The agent returns plain text and does not call Slack tools for this path. Threaded replies first use
`SlackResponseStream`, which resolves the already-routed identity's bot token and calls Slack's
status and streaming APIs through `ctx.http.fetch`. Top-level replies and streaming fallbacks use
`createProviderTool(slack_bot_post_message)`, which applies the standard validation, identity,
resource, credential, perform, and redaction pipeline.

Slack ingress also depends on matching Paperclip host support. The host must expose a
company-scoped webhook route, pass the route-derived `companyId` into `handleWebhook`, and preserve
the worker's HTTP response. It must also support `events.emit` and deliver plugin self-events and
session notifications with fresh company invocation scope. Slack credential setup and resolution additionally require the
company-scoped config and secret RPC contracts described in the README. The repository's pnpm SDK
patch covers only the worker side of those calls and cannot add the corresponding server behavior.

The host has no session-send request key. A non-`Session not found` send failure is therefore
ambiguous: ingress persists `uncertain`, closes/retires the session, completes the event claim, and
does not resend automatically. A restart plus any later duplicate/new webhook re-kicks persisted
work. A restart after acknowledgement with no later trigger remains a host limitation requiring
durable scheduling or request-key support.

The queue uses plugin state plus process-local enqueue/drain tails and write/read-back claim tokens.
Because `ctx.state` exposes no compare-and-set transaction, two worker processes can still race after
one confirms ownership; cross-worker exactly-once claiming is not promised.

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
- Apply the human settings actor guard as the first statement of any new settings mutation or credential/setup action; do not apply it to read-only tool-backed status actions or `ping` without a separate authorization requirement.
- Run `pnpm typecheck` and `pnpm test`; run `pnpm build` when entrypoints or bundling change.
