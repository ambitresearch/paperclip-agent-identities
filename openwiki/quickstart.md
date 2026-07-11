# OpenWiki quickstart

## What this repository is

This repository contains **Agent Identities**, a TypeScript Paperclip plugin that connects each Paperclip agent to service-specific identity providers and contribution tools. GitHub is the first identity provider. The plugin lets operators map Paperclip agent IDs to GitHub usernames, GitHub App credentials, and optional commit author metadata.

Primary product capabilities are described in `/README.md` and implemented through the Paperclip plugin manifest and worker:

- Configure one identity per Paperclip agent/provider pair.
- Leave repository/resource access decisions to provider permissions such as GitHub App installations and scopes.
- Bootstrap private GitHub Apps from the settings page with GitHub's App Manifest flow.
- Store public provider identity metadata in Paperclip plugin state, private credential references in a local sidecar file, and GitHub App bindings in the selected agent environment.
- Mint short-lived GitHub App installation tokens just in time for GitHub provider tools.
- Expose provider-specific tools for identity self-checks, pull request creation, and mediated branch pushes.

Treat `/README.md` plus current source as the canonical documentation baseline.

## Start here for common tasks

| Task | Start with | Then inspect |
| --- | --- | --- |
| Understand plugin registration and runtime shape | [Plugin runtime architecture](architecture/plugin-runtime.md) | `/src/manifest.ts`, `/src/worker.ts` |
| Change identity config, provider projection, or credential resolution | [Agent identity domain](domain/agent-identities.md) | `/src/shared/types.ts`, `/src/identity-policy.ts`, `/src/config-source.ts`, `/src/credential-sidecar.ts` |
| Change GitHub App setup or settings UI behavior | [Agent identity domain](domain/agent-identities.md) | `/src/ui/SettingsPage.tsx`, `/src/worker.ts` manifest-flow actions |
| Change PR or push tools | [GitHub contribution tools](tools/github-contribution-tools.md) | `/src/providers/github/tools/create-pull-request.ts`, `/src/providers/github/tools/push-branch.ts` |
| Run validation or understand test coverage | [Testing and operations](operations/testing-and-release.md) | `/tests/*.spec.ts`, `/package.json` |
| Register a provider's runtime tools/actions | [Plugin runtime architecture](architecture/plugin-runtime.md) | `/src/providers/<id>/`, `/src/providers/index.ts` |
| Add provider settings persistence/UI | [Agent identity domain](domain/agent-identities.md) | `/src/core/identity-config.ts`, `/src/credential-sidecar.ts`, `/src/worker.ts`, `/src/ui/SettingsPage.tsx` |
| Implement the Slack provider | [Slack provider MVP and threat model](domain/slack-provider-design.md) | `/src/providers/slack/` plus the settings-persistence files above |

## Repository layout

```text
/src
  manifest.ts                         Paperclip manifest: capabilities, tool declarations, UI slots
  worker.ts                           Worker setup: data loaders, actions, tools, manifest-flow actions
  shared/types.ts                     Shared identity/settings/provider/GitHub App flow types
  config-source.ts                    Resolves identity config from instance config, then settings state fallback
  identity-policy.ts                  Agent identity parsing and GitHub repo normalization
  credential-sidecar.ts               Local credential reference sidecar and GitHub App token minting
  github-bot-push-branch*.ts          Mediated push tool definition and implementation
  tools/create-pull-request.ts        PR creation tool implementation
  shared/github-bot-*-tool.ts         Tool metadata used by manifest and worker
  ui/index.tsx                        Dashboard widget export and settings page export
  ui/SettingsPage.tsx                 Operator settings UI and GitHub App setup flow
  lib/*.ts                            Redaction and lower-level PR/push helper utilities
/tests/*.spec.ts                      Vitest coverage for plugin, tools, repo normalization, credentials, security
/esbuild.config.mjs                   Main build path using Paperclip SDK bundler presets
/rollup.config.mjs                    Alternate Rollup build config
/package.json                         Scripts, package metadata, Paperclip entrypoint metadata
/README.md                            User-facing project overview and setup notes
```

Build output is generated under `/dist/` and is referenced by `package.json` and `/src/manifest.ts`. Do not edit `dist` by hand.

## Development commands

The package uses pnpm 10.17.1 and ESM TypeScript. Core commands from `/package.json` and `/README.md`:

```bash
pnpm install
pnpm dev            # watch worker, manifest, and UI builds into dist/
pnpm dev:ui         # Paperclip plugin dev server for dist/ui on port 4177
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .
pnpm docs:dev       # preview OpenWiki docs with VitePress
```

For installing locally into Paperclip:

```bash
pnpm build
paperclipai plugin install . --local
```

## Runtime model in one page

1. Paperclip reads the plugin package metadata in `/package.json`, then loads the built manifest, worker, and UI from `dist`.
2. `/src/manifest.ts` declares plugin ID `roshangautam.paperclip-agent-identities`, version `0.1.3`, required capabilities, three tools, and two UI slots.
3. `/src/worker.ts` calls `definePlugin()` and registers:
   - data loaders: `health`, `bot-identity-config`, `paperclip-agents`
   - actions: `ping`, `save-bot-identity-config`, `delete-bot-identity-config`, GitHub App manifest-flow actions
   - tools: `github_bot_whoami`, `github_bot_create_pull_request`, `github_bot_push_branch`
   - an `issue.created` event observer that marks issues as seen in plugin state
4. `/src/ui/index.tsx` exports a dashboard widget summarizing identity coverage and re-exports the settings page.
5. GitHub tools validate and normalize repository inputs, resolve the calling agent's identity, then resolve credentials just in time. Provider permissions decide repository/resource access.

See [Plugin runtime architecture](architecture/plugin-runtime.md) for details.

## Key business/domain concepts

- **Agent identity**: a provider-aware mapping keyed by `${agentId}:${provider}`, with label, provider ID, provider account fields, selected-agent credential cascade, and optional commit author fields. GitHub is the only enabled provider today; Slack, Mattermost, Microsoft Entra, Google Cloud, and AWS are listed as coming soon.
- **Provider authorization**: repository/resource access is owned by the provider. For GitHub, App installation permissions and scopes decide which repositories tools can access.
- **Credential sidecar**: an operator-local JSON file, defaulting to `/paperclip/.paperclip/agent-identities/credentials.json`, that stores credential references by `${agentId}:${provider}` but not generated installation tokens.
- **GitHub App path**: preferred credential mode. The settings UI creates a GitHub App manifest, the worker converts the one-time code, writes a private key file, and later mints short-lived installation tokens on tool calls.
- **Fallback credentials**: secret ID or token file sources are still supported for dev and recovery flows, but GitHub App credentials are the durable path described in the README.

See [Agent identity domain](domain/agent-identities.md) for the canonical model.

## Guidance for future agents

- Read `/README.md` and this quickstart first; then follow the section links above.
- Before changing behavior, inspect tests for the relevant domain. The suite encodes important fail-closed and no-secret-leak expectations.
- Preserve the pipeline security order for every provider tool: validate params -> resolve identity -> resolve resource ref -> resolve credentials -> perform -> redact. See `/README.md#security-order-all-provider-tools`.
- Do not document or inspect live secret material. Avoid `.env` files and private key/token files.
- If adding settings fields, update shared types, worker normalization, UI form behavior, and tests together.
- If changing tool schemas, update both manifest metadata and worker registration behavior, then run `pnpm typecheck` and `pnpm test`.
- When adding a new identity provider, follow `/README.md#adding-a-provider`:
  implement the runtime `IdentityProvider` under `/src/providers/<id>/` and
  append it once to `/src/providers/index.ts`; do not add provider-specific
  runtime registration branches to `/src/worker.ts` or `/src/manifest.ts`. A
  provider exposed in settings must still extend the persistence normalization
  in `/src/worker.ts`, the shared schemas, and the UI as described there.
