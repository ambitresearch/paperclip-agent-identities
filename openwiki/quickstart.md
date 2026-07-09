# OpenWiki quickstart

## What this repository is

This repository contains **Agent Identities**, a TypeScript Paperclip plugin that gives each Paperclip agent a configured GitHub bot identity and contribution tools. GitHub is the first identity provider. The plugin lets operators map Paperclip agent IDs to GitHub usernames, repository allow-list patterns, GitHub App credentials, and optional commit author metadata.

Primary product capabilities are described in `/README.md` and implemented through the Paperclip plugin manifest and worker:

- Configure one GitHub identity per Paperclip agent.
- Restrict each identity to explicit `owner/repo` glob patterns.
- Bootstrap private GitHub Apps from the settings page with GitHub's App Manifest flow.
- Store public identity metadata in Paperclip plugin state, private credential references in a local sidecar file, and GitHub App bindings in the selected agent environment.
- Mint short-lived GitHub App installation tokens just in time.
- Expose tools for identity self-checks, pull request creation, and mediated branch pushes.

Treat `/README.md` plus current source as the canonical documentation baseline.

## Start here for common tasks

| Task | Start with | Then inspect |
| --- | --- | --- |
| Understand plugin registration and runtime shape | [Plugin runtime architecture](architecture/plugin-runtime.md) | `/src/manifest.ts`, `/src/worker.ts` |
| Change identity config, repository policy, or credential resolution | [Agent identity domain](domain/agent-identities.md) | `/src/shared/types.ts`, `/src/identity-policy.ts`, `/src/config-source.ts`, `/src/credential-sidecar.ts` |
| Change GitHub App setup or settings UI behavior | [Agent identity domain](domain/agent-identities.md) | `/src/ui/SettingsPage.tsx`, `/src/worker.ts` manifest-flow actions |
| Change PR or push tools | [GitHub contribution tools](tools/github-contribution-tools.md) | `/src/tools/create-pull-request.ts`, `/src/github-bot-push-branch.ts` |
| Run validation or understand test coverage | [Testing and operations](operations/testing-and-release.md) | `/tests/*.spec.ts`, `/package.json` |

## Repository layout

```text
/src
  manifest.ts                         Paperclip manifest: capabilities, tool declarations, UI slots
  worker.ts                           Worker setup: data loaders, actions, tools, manifest-flow actions
  shared/types.ts                     Shared identity/settings/GitHub App flow types and repo validation
  config-source.ts                    Resolves identity config from instance config, then settings state fallback
  identity-policy.ts                  Agent identity parsing and GitHub repo normalization/policy checks
  credential-sidecar.ts               Local credential reference sidecar and GitHub App token minting
  github-bot-push-branch*.ts          Mediated push tool definition and implementation
  tools/create-pull-request.ts        PR creation tool implementation
  shared/github-bot-*-tool.ts         Tool metadata used by manifest and worker
  ui/index.tsx                        Dashboard widget export and settings page export
  ui/SettingsPage.tsx                 Operator settings UI and GitHub App setup flow
  lib/*.ts                            Redaction and lower-level PR/push helper utilities
/tests/*.spec.ts                      Vitest coverage for plugin, policy, tools, repo validation, security
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
5. GitHub tools resolve the calling agent's identity, enforce repository policy, then resolve credentials only after policy checks pass.

See [Plugin runtime architecture](architecture/plugin-runtime.md) for details.

## Key business/domain concepts

- **Agent identity**: a per-agent mapping keyed by Paperclip `agentId`, with label, GitHub username, allowed repository patterns, selected-agent credential cascade, and optional commit author fields.
- **Repository policy**: `owner/repo` glob patterns such as `my-org/*`, `my-org/my-repo`, and `*/*`. Current default when no pattern is configured is `*/*`.
- **Credential sidecar**: an operator-local JSON file, defaulting to `/paperclip/.paperclip/agent-identities/credentials.json` with a legacy `/paperclip/.paperclip/github-bot-identity/credentials.json` fallback, that stores credential references but not generated installation tokens.
- **GitHub App path**: preferred credential mode. The settings UI creates a GitHub App manifest, the worker converts the one-time code, writes a private key file, and later mints short-lived installation tokens on tool calls.
- **Fallback credentials**: legacy secret ID or token file sources are still supported, but GitHub App credentials are the durable path described in the README.

See [Agent identity domain](domain/agent-identities.md) for the canonical model.

## Guidance for future agents

- Read `/README.md` and this quickstart first; then follow the section links above.
- Before changing behavior, inspect tests for the relevant domain. The suite encodes important fail-closed and no-secret-leak expectations.
- Preserve the security order in GitHub tools: validate inputs and repository policy before resolving secrets or tokens.
- Do not document or inspect live secret material. Avoid `.env` files and private key/token files.
- If adding settings fields, update shared types, worker normalization, UI form behavior, and tests together.
- If changing tool schemas, update both manifest metadata and worker registration behavior, then run `pnpm typecheck` and `pnpm test`.
