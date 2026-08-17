# Plugin runtime architecture

## Plugin-managed skills

The manifest may bundle specialized agent workflows alongside provider tools by declaring `skills` and the `skills.managed` capability. Each declaration has a stable `skillKey`, display metadata, the main `SKILL.md` markdown, and optional supporting files such as references. Paperclip reconciles these declarations into company skills under the plugin-owned key `plugin/<plugin-id>/<skill-key>`; operators can then attach them to selected agents through the normal desired-skill flow.

Agent Identities ships `code-review` as its first managed skill. It runs a provider-neutral pull request review workflow using the current agent runtime first, then optional local reviewers such as Codex, Claude Code, or Copilot CLI when they are already installed and authenticated. Copilot CLI is never a prerequisite: minimal Paperclip and Coder runtimes can still complete the default review path, while absent optional CLIs are reported as unavailable reviewers. The skill submits decisive GitHub reviews: it approves clean PRs, requests changes for verified blockers, and uses non-decisive comments only when explicitly requested or when the evidence is inconclusive.

The managed review workflow is designed for Paperclip/Coder workspaces. It reviews committed pull request `base...head` ranges instead of treating harness-owned untracked files such as `.paperclip-runtime/` as candidate dirt. It also checks the PR review timeline before reviewing; if the same agent identity already reviewed the current head SHA, the agent links the existing review instead of reposting duplicate findings unless the caller explicitly requests a re-review.

Managed skill source lives under `/skills/<skill>/`. The manifest build treats Markdown as text and embeds it in `dist/manifest.js`, so dist-only deployments have no sibling-file dependency. `package.json` also includes `/skills` in the npm artifact for auditability. Adding a skill therefore requires updating the manifest declaration, bundler coverage, capability tests, and this OpenWiki runtime inventory.

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

- plugin ID: `ambitresearch.paperclip-agent-identities`
- display name: `Agent Identities`
- version: `0.4.0`
- category: `connector`
- entrypoints: `./dist/worker.js` and `./dist/ui`

Important capabilities include:

- `plugin.state.read` / `plugin.state.write` for settings state and GitHub App manifest flow state
- `instance.settings.register` and `ui.dashboardWidget.register` for the UI slots
- `agent.tools.register` for the GitHub tools
- `agents.read` for populating the settings-page agent dropdown
- `events.subscribe` / `events.emit` for the provider-owned, company-scoped Slack queue-drain self-event
- `jobs.schedule` for the host-backed Slack queue recovery scan
- `agent.sessions.create`, `agent.sessions.list`, `agent.sessions.send`, and `agent.sessions.close` for the Slack inbound
  message reply lifecycle
- `http.outbound` for GitHub API and host REST calls
- `secrets.bind-ref` for binding existing Paperclip secret references into company plugin config
- `secrets.read-ref` for Paperclip secret resolution
- `activity.log.write` for PR/push audit events
- `skills.managed` for reconciling the plugin-managed `code-review` company skill
- `issues.read` and `execution.workspaces.read` for resolving a push against the invoking run's execution workspace
- `project.workspaces.read` for the mediated push fallback to the project's primary workspace

`/src/manifest.ts` sources its tool list from the provider registry rather than importing provider-specific tool definitions directly: it filters every provider's `manifestTools` down to the names present in `registry.liveTools()`. `liveTools()` is a provider-neutral gate distinct from `enabled()`: it returns every tool from a `toolsEnabled()` provider (`definition.toolsStatus ?? definition.status === "enabled"`), PLUS any individual tool a not-yet-`toolsEnabled()` provider marks `live: true` on its `ProviderToolSpec`. This lets a provider ship real, live tools before its full identity/settings-UI surface (`enabled()`) is ready, without adding a provider-specific branch to `/src/manifest.ts` or `/src/worker.ts` — `/src/worker.ts`'s tool-registration loop iterates the same `registry.liveTools()` list. Today `registry.liveTools()` contributes:

- `github_bot_whoami`
- `github_bot_create_pull_request`
- `github_bot_push_branch`
- `github_bot_submit_pull_request_review`
- `slack_bot_whoami` (DRO-972), `slack_bot_post_message` (DRO-973), `slack_bot_add_reaction`/`slack_bot_remove_reaction` (DRO-974), and `slack_bot_lookup_channel` (DRO-975/DRO-1160) — Slack is now a fully `enabled` provider (visible in the settings-page identity picker) and also sets `toolsStatus: "enabled"`, so its whole tool surface registers in the live worker/manifest

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
- `plugin.ambitresearch.paperclip-agent-identities.slack-turn-drain`: contributed
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

- via `registry.liveTools()` (all tools from `toolsEnabled()` providers — providers whose `toolsStatus` is `"enabled"` independent of their settings-UI `status` — plus any individual tool from a not-yet-`toolsEnabled()` provider that opts in via `toolSpec.live: true`), wraps each composed tool through `createProviderTool()` in `/src/core/tool-pipeline.ts`, which enforces the common deny-before-secret pipeline (validate params -> resolve identity -> resolve/deny resource ref -> resolve credential -> perform -> redact secrets), and registers the resulting handler with `ctx.tools.register`. Slack exposes its five current tools this way via `toolsStatus: "enabled"`, and the provider itself is now fully `"enabled"` in the settings UI;
- for **every registered provider, enabled or not** (`registry.all()`), calls the provider's optional `contributeActions(ctx)` hook. This is how the GitHub provider registers its GitHub App manifest actions (`create-github-app-manifest`, `get-github-app-manifest-flow`, `convert-github-app-manifest`) without `/src/worker.ts` importing GitHub-specific action code directly, and it's also why a not-yet-`enabled()` provider with no tool surface yet can still ship setup/bootstrap actions ahead of `tools` landing — `contributeActions` is intentionally not gated on `enabled()`.

The hook name is historical: it is the existing provider setup seam and may
also register provider-owned event handlers and jobs. Slack composes its queue
drain self-event and `slack-queue-recovery` scheduled job there; the worker still
contains no Slack-specific branch.

Concretely, GitHub's tools (`github_bot_whoami`, `github_bot_create_pull_request`, `github_bot_push_branch`, and `github_bot_submit_pull_request_review`) live in `/src/providers/github/tools/*.ts` and are exposed through `githubProvider.tools` in `/src/providers/github/index.ts` — the worker loop is provider-agnostic and would pick up a new provider's tools/actions the same way once it's added to the registry.

### Provider webhooks and Slack sessions

The manifest declares provider webhook endpoints from `registry.webhooks()`, and the worker routes
each delivery to the matching provider handler. Slack's `slack-events` handler verifies the request,
routes it by app ID plus team ID, and persists a bounded turn in one version-2 per-conversation state
record. That record owns the reusable session mapping, ordered pending turns, active/accepted/uncertain
phase, and completed event hashes retained for 24 hours from completion. The webhook then awaits a
company-scoped `slack-turn-drain` emit and returns HTTP 200; it does not call session APIs or wait for
an earlier run.

Slack contributes one self-event handler and one host-backed scheduled job through its provider setup
hook. A fresh self-event invocation drains at most one queued turn, resolves/reuses the conversation
session, and calls `sendMessage`. Every enqueue first registers its conversation key in a durable,
agent-scoped index. Every two minutes, `slack-queue-recovery` enumerates companies, their non-terminated
agents, and those indexed conversation records, then invokes the same drain path used by the self-event.
This recovers persisted work after a worker restart and queued FIFO successors whose post-finalization
self-event emit failed, without requiring another Slack webhook.

The callback is bound to the persisted accepted `runId`; pre-result events are buffered, stale events
are ignored, and terminal handling awaits reply finalization before completing the event claim,
clearing active state, and kicking the FIFO successor. A live 30-minute accepted lease remains owned
and is left untouched by recovery. An expired accepted or uncertain claim is retired, its session is
closed, and the claim is retained as a terminal dead letter rather than replayed. Queued turns carry a
bounded attempt counter and are dead-lettered after five dispatch attempts; diagnostics expose only
bounded company, agent, conversation, reason, and count metadata rather than event bodies or tokens.
The accepted session callback still finalizes its own run.
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
ambiguous: ingress persists `uncertain`, closes/retires the session, and does not resend automatically.
The scheduled recovery path restores only clearly queued work and reconciles expired leases into
terminal dead letters; it never blindly replays accepted or uncertain work.

The queue uses plugin state plus process-local enqueue/drain/job tails and write/read-back claim tokens.
Because `ctx.state` exposes no compare-and-set transaction, two worker processes can still race
after one confirms ownership; cross-worker exactly-once claiming is not promised.

The recovery registry that tells the scan *which* conversations to revisit deliberately does not use
plugin state. It lives in `ctx.entities` as one record per conversation, keyed by an `externalId` of
`${companyId}:${conversationKey}` under the agent scope. A single shared index array would be
read-modify-write: two workers registering different conversations could each read the same snapshot,
and the later write would drop the earlier key permanently, stranding that queue from recovery
forever. Because the host upserts by `externalId`, concurrent registrations touch disjoint rows and
cannot overwrite one another, and repeat registrations of the same conversation collapse onto one
row. Company scoping lives in the `externalId` rather than a single in-record discriminator, so an
agent belonging to more than one company keeps one registry per company instead of silently losing
coverage for the second.

Conversations are retired from the registry once a recovery drain observes a fully idle queue, so
per-tick cost tracks conversations with real work rather than every conversation the agent has ever
seen. Enqueue re-registers unconditionally, so a retired conversation that goes active again is
picked back up.

The scan itself is failure-isolated at two levels. A per-conversation drain failure is logged and the
sweep continues; a per-company failure — including the agent listing — is caught so one bad tenant
cannot starve every tenant ordered after it. Because iteration order is stable, an unisolated throw
would have starved those same tenants on every subsequent tick, not just once. Per-tick bounds
truncate and report through the scan summary rather than throwing, so an oversized tenant degrades to
partial coverage instead of a fleet-wide recovery outage. Each tick logs a secret-free summary
(companies/agents/conversations visited, failure counts, and whether the tick truncated) so
saturation and starvation are observable.

## Config and state sources

There are two identity configuration paths:

1. **Plugin instance config** via `ctx.config.get()`.
2. **Settings-page state** under `CONFIG_SCOPE`, defined in `/src/config-source.ts` as `{ scopeKind: "instance", stateKey: "bot-identity-config" }`. `/src/config-source.ts` exports only this constant — it does not implement any resolution logic itself.

The instance-config manifest accepts the current per-agent provider container, where new Slack
records contain only the required credential refs, and the temporary full nested or flat Slack
compatibility shapes. Existing flat records keep their layout when credential refs are updated. It rejects mixed records, including stale top-level Slack fields beside a
GitHub or nested Slack identity and GitHub commit metadata on the legacy flat Slack shape, so the
runtime never silently ignores provider-specific values.

`resolveIdentityForProvider()` in `/src/worker.ts` is the provider-agnostic resolver every provider tool goes through. Providers use instance config first and settings state as a fallback by default. A provider may instead mark settings state authoritative; Slack does this because public metadata lives in state while instance config contains credential refs. Authoritative providers never read or fall back to instance identity metadata, so stale host scalars cannot resurrect a deleted identity and credential-free tools remain available during a config-read outage.

Settings state is normalized to version 5 nested provider records (`BOT_IDENTITY_SETTINGS_VERSION` from `/src/core/identity-config.ts`):

```ts
{
  version: 5,
  identities: Record<`${agentId}:${provider}`, AgentIdentityConfig>,
  cleanupTombstones: Record<string, LegacySlackSidecarCleanupTombstone>
}
```

`normalizeSettingsState()` migrates stored v3 (flat `githubUsername`/`commitName`/etc.) and v4 state into v5 automatically; there is no v3 or v4 runtime read/write path. `cleanupTombstones` retains retry state for released Slack-sidecar cleanup. Each provider's `projectPluginConfig` narrows the v5 identity map to its own `provider` discriminant and reads its nested fields (GitHub reads `identity.github.username`, etc.) — the worker loop itself stays provider-agnostic.

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
