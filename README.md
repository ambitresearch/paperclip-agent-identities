# Agent Identities

Per-agent identity providers and contribution tools for Paperclip. GitHub is the first provider.

## Features

- Configure one identity per Paperclip agent and provider pair.
- Choose from a provider registry: GitHub is enabled now; Slack, Mattermost, Microsoft Entra, Google Cloud, and AWS are tracked as coming soon.
- Prevent duplicate identities for the same agent/provider pair.
- Leave repository/resource access decisions to provider permissions such as GitHub App installations and scopes.
- Create GitHub Apps with GitHub's App Manifest flow from the settings page.
- Store public identity metadata in plugin state; GitHub credential references in a local sidecar; and Slack typed secret refs in company-scoped host config.
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

### Required Paperclip host support for Slack

The Slack setup and Events API paths require a Paperclip host that implements
the company-scoped plugin contracts used by this branch:

- webhook delivery through
  `/api/companies/<companyId>/plugins/<pluginId>/webhooks/<endpointKey>`, with
  the route-derived `companyId` passed to the worker and the worker's HTTP
  status, headers, and body returned to Slack;
- company-scoped plugin config reads and atomic secret-reference patches; and
- company-scoped secret resolution for the configured bot-token and signing-secret refs;
- `ctx.events.emit(name, companyId, payload)` plus fresh company invocation
  scope on `plugin.<pluginId>.<name>` handlers and agent-session event
  callbacks. Slack ingress uses a provider-owned `slack-turn-drain` self-event
  to move session calls out of the webhook invocation.

For a dispatchable Slack event, the webhook verifies the signature and route,
persists a bounded turn in the per-conversation plugin-state queue, awaits the
self-event emit, and then returns HTTP 200. It never calls
`ctx.agents.sessions.sendMessage` or waits for a prior run in webhook scope. Queue state
retains up to 32 active/pending turns per conversation, hashes event IDs, and keeps completed
claims for 24 hours from completion. A full queue or failed self-event emit is
retryable before acknowledgement.

This path is designed to fit Slack's three-second acknowledgement window, but
the actual latency still includes host config/secret/state RPCs and the awaited
event emit. Those host operations must themselves remain available and timely.

The self-event drains one turn under fresh company scope. Accepted runs carry a
durable 30-minute lease; only a later fresh webhook/self-event or a terminal
session callback may finalize its accepted run; expired-run retirement and
session close happen only under a later fresh webhook/self-event scope. Generic
`sendMessage` failures are ambiguous because the host has no request-key API:
the provider marks the turn uncertain, retires the session, completes the event
claim, and never auto-resends. Only the host's definitive `Session not found`
response is safe to retry on a replacement session. This prevents duplicate
runs but cannot provide exactly-once delivery beyond that host boundary.

A worker restart is recoverable when a duplicate or new webhook arrives and
re-kicks the persisted queue. If the worker restarts after acknowledgement and
no later webhook/event arrives, queued work has no trigger; closing that gap
requires host-backed durable event scheduling or a request-key/idempotency API.
Likewise, a failed successor emit after terminal finalization leaves that
successor durable but waiting for the next duplicate/new webhook trigger.
Plugin state also has no compare-and-set primitive, so claim-token read-back
detects observable write races but does not make multi-worker execution atomic.

Slack install metadata and secret refs live under `identities.<agentId>.slack`, so the same
agent's existing flat GitHub instance config remains intact when Slack is saved or deleted.

Upgrades from released `v0.1.7`/`v0.1.8` may still have a legacy
`identities.<agentId>:slack.slackBotToken` entry in the local sidecar. Settings
shows **Rebind required** for that identity. Open **Edit**, select the signing
secret's Paperclip company-secret UUID when the released entry does not already
contain one, then choose **Rebind released credentials**. The worker verifies
the host-authorized company and agent membership, copies only typed UUID refs to
`identities.<agentId>.slack`, and never resolves either secret value. A matching
existing binding makes the retry idempotent; a conflicting binding is rejected.
If sidecar deletion fails after binding, Settings reports **Cleanup pending** and
the same action safely retries only cleanup. Reinstalling the Slack App is not
required for this migration.

The stock `2026.707.0` host does not provide those server-side contracts. The
pnpm patch in this repository updates the plugin worker SDK boundary, but it
does not make an unmodified Paperclip server compatible. Install this plugin
only with a host build containing the matching core support.

## Identity Config Model

Agent Identities uses a provider-aware settings state. Each saved identity is keyed by `agentId + provider`, using the identity key format `${agentId}:${provider}`. The settings page stores a version 4 map in Paperclip plugin state:

```ts
{
  version: 4,
  identities: Record<`${agentId}:${provider}`, AgentIdentityConfig>
}
```

Core fields:

- `id`: stable identity key, for example `agent-123:github`
- `agentId`: Paperclip agent ID
- `provider`: provider ID such as `github`
- `label`: human-facing label, conventionally `Agent Name [Company Name]`
- `github.username`: GitHub App login for GitHub identities, commonly `<app-slug>[bot]`
- Optional `github.commitName` and `github.commitEmail`
- `slack.teamId`, `slack.appId`, and `slack.botUserId`: public Slack installation metadata

Each provider projects its own version 4 identity records into runtime config by `agentId`. Repository and channel access remains controlled by provider permissions and API responses, not by Agent Identities.

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
        "privateKeyFile": "<runtime-home>/.paperclip/agent-identities/github-apps/<agent>/private-key.pem"
      }
    }
  }
}
```

Default sidecar path: `<runtime-home>/.paperclip/agent-identities/credentials.json`, resolved with Node's `os.homedir()`. This is `/Users/<user>/.paperclip/...` for a native macOS run and remains `/paperclip/.paperclip/...` in the Paperclip container, whose runtime home is `/paperclip`. `PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS` overrides the default when the worker host passes that environment variable (including tests and custom worker hosts); relative override values are resolved against the worker's current directory and reported to the settings UI as absolute paths. The plugin worker reads this sidecar when its GitHub provider tools need credentials. The saved agent environment receives `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, and either `GITHUB_APP_PRIVATE_KEY` as a Paperclip secret reference or `GITHUB_APP_PRIVATE_KEY_FILE` as a private-key file path. The plugin tries the configured private-key secret first and falls back to `privateKeyFile` when a file path is present. It uses those GitHub App credentials to mint a fresh installation token on each GitHub tool call; generated tokens are not stored.

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

OpenWiki Markdown lives in [`openwiki/`](openwiki/quickstart.md). Coding agents update affected pages in the same feature or behavior-change pull request; local or cloud agents may submit weekly or manual catch-up documentation pull requests. GitHub Actions builds and validates the content, then publishes it as a searchable VitePress site through GitHub Pages.

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

- `pnpm docs:build` (including internal-link validation)
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm pack --pack-destination .`
- Uploads `*.tgz` as workflow artifact `npm-package-tarball`

### Releases

Every push to `main` compares the merged `package.json` version with the previous commit. If the version is unchanged, the release workflow exits successfully. If it changed, the workflow requires a greater stable version, verifies that `src/manifest.ts` matches, validates the package, tags that exact merged SHA, creates the GitHub Release, and dispatches tag-based npm publication. Regular CI enforces package/manifest parity even when a release is skipped.

Version bumps are explicit normal pull-request changes. CI requires a canonical SemVer version greater than the base revision whenever `package.json` changes. Set the intended patch, minor, or major version in both `package.json` and `src/manifest.ts`; the merge is the release trigger. The workflow never increments versions or writes to `main`. Real npm publication accepts only a stable `v<major>.<minor>.<patch>` tag whose package and manifest versions match. `NPM_TOKEN` remains a repository secret used only by the publish workflow.


Run the same validation locally:

```bash
corepack enable
corepack prepare pnpm@10.17.1 --activate
pnpm install --frozen-lockfile
pnpm docs:build
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

The plugin composes runtime identity-provider tools and actions behind a single
`IdentityProvider` contract (`src/core/provider-contract.ts`). Runtime
registration is generic: `src/worker.ts` and `src/manifest.ts` consume the
registry in `src/providers/index.ts`, so adding a provider's runtime tools does
not require a provider-specific registration branch in either file.

Settings persistence is a separate boundary and is not fully generic today.
Providers that can be created or edited in the settings UI must also extend the
persisted identity union and the appropriate credential-reference schema,
introduce or extend a provider-keyed settings-normalizer dispatch in
`src/worker.ts`, and add the corresponding UI form/projection. `src/manifest.ts` remains provider-agnostic;
`src/worker.ts` changes only at the settings-persistence boundary, not to
register runtime tools or actions.

To add a provider:

1. Create a new module under `src/providers/<id>/` that implements `IdentityProvider<TIdentity, TRef>`.
2. Write `validateConfig` to parse a single projected identity and return either the typed identity or a joined error string (see `validateGitHubConfig` in `src/providers/github/index.ts` for the pattern).
3. If the provider is editable in settings, extend the persistence
   discriminated union and credential-reference schema, add its provider-keyed normalization adapter to the
   worker's settings dispatch, and add its UI form/projection. A runtime-only
   provider can skip this step.
4. Project raw settings-state identities for your provider's key (`${agentId}:<id>`) into that typed identity shape.
5. Implement credential resolution (`resolveCredential`) — resolve secrets/tokens just in time, never eagerly, and never before params/identity/resource-ref have been validated.
6. Provide `tools`: an array of `ProviderToolSpec` entries, each declaring its metadata, whether it requires a credential, and its `perform` implementation.
7. Optionally contribute `actions` (e.g. an App-manifest-style setup flow) if the provider needs additional worker actions beyond tool calls.
8. Include `manifestTools`: the manifest-facing fragments the composed manifest consumes (see `src/providers/github/manifest-tools.ts`).
9. Append the new provider exactly once, in `src/providers/index.ts`'s `ALL_PROVIDERS` array. This is the single runtime composition root; no provider-specific registration branch belongs in `worker.ts` or `manifest.ts`.
10. Add contract tests (validate/project/resolveCredential) and pipeline tests (tool execution through `createProviderTool`) alongside the existing provider test suites, and extend `tests/provider-composition.spec.ts` if the new provider changes composed output.

### Security order (all provider tools)

Every credentialed tool call runs through the shared pipeline in `src/core/tool-pipeline.ts` in this fixed order:

1. **Validate params** — deny malformed input before any secret work.
2. **Resolve identity** — fail closed on any error.
3. **Resolve resource ref** — derive/validate the target and deny disallowed targets before a credential exists.
4. **Resolve credentials** — the first point secret material is touched, only after all prior denials.
5. **Perform** — the only provider-specific API/git step.
6. **Redact** — strip the resolved token and any other secrets from the tool result before it is returned.

Provider authors implement steps 1, 3 (optional), 4, and 5; the pipeline enforces the ordering and step 6.
