# Testing and operations

## Local development loop

Use the commands from `/package.json` and `/README.md`:

```bash
pnpm install
pnpm dev            # watch builds for worker, manifest, and UI into dist/
pnpm dev:ui         # UI dev server for dist/ui on port 4177
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .
```

The package manager is pinned in `/package.json` as `pnpm@10.17.1`.

For local Paperclip installation:

```bash
pnpm build
paperclipai plugin install . --local
```

Local installs run trusted code from this repository and Paperclip watches rebuilt output from `dist/`.

## Build details

The primary build path is `/esbuild.config.mjs`, which uses Paperclip SDK bundler presets to build:

- worker bundle
- manifest bundle
- UI bundle from `src/ui/index.tsx`

The package metadata points Paperclip at:

```json
{
  "manifest": "./dist/manifest.js",
  "worker": "./dist/worker.js",
  "ui": "./dist/ui/"
}
```

`/rollup.config.mjs` exists as an alternate Rollup build path via `pnpm build:rollup`.

## Test suite

Tests run with Vitest. `/vitest.config.ts` includes both `tests/**/*.spec.ts` (plain Node-environment tests, the default) and `tests/**/*.spec.tsx` (React/DOM interaction tests, e.g. `tests/ui/settings-page-interactions.spec.tsx`, which opt into jsdom per-file via a `// @vitest-environment jsdom` comment at the top of the file).

Current test files:

- `/tests/plugin.spec.ts`
  - manifest capabilities and UI slot
  - worker data/action registration
  - settings save/load/delete flows
  - Paperclip agent dropdown data
  - `github_bot_whoami`
  - push tool success, denial, dry-run, credential failure, redaction
  - GitHub App manifest creation/conversion and private-key file persistence
  - sidecar writes/deletes and provider-aware settings fallback
  - released Slack sidecar deletion while preserving sibling GitHub entries
- `/tests/settings-action-authorization.spec.ts`
  - table-driven agent/system denial for every protected settings/setup action before state, config, secret, agent-list, or HTTP access
  - malformed actor rejection and local implicit-user (`userId: null`) success
- `/tests/providers/slack/app-manifest.integration.spec.ts`
  - released `v0.1.7`/`v0.1.8` Slack credential rebind, conflict, and cleanup-pending recovery
  - deterministic metadata-discovery marker serialization/ownership
  - deterministic Slack delete-rollback versus queued-save interleaving
- `/tests/process-local-mutation-queue.spec.ts`
  - failed mutations release their process-local queue key for later work
- `/tests/providers/slack/ingress-conversation-queue.spec.ts`
  - bounded persisted turns, pending/active/completed dedup, 24-hour completion retention, v1 ledger/run migration beyond minute 10, and unowned-thread fail-closed behavior
- `/tests/providers/slack/ingress-provider-webhook.spec.ts`
  - persist-before-ack and no session send in webhook scope
  - deferred self-event draining, duplicate-drain coalescing, cross-conversation concurrency, FIFO successor kicks, accepted-run callback binding, stale callback rejection, and terminal reply-finalization ordering
  - kick failure retention, ambiguous-send uncertain retirement/no replay, expired-lease retirement only under fresh scope, and restart plus webhook recovery
- `/tests/providers/slack/ingress-session-reply.spec.ts`
  - structured adapter-output reduction and bounded Slack reply truncation
- `/tests/providers/slack/ingress-worker-integration.spec.ts`
  - manifest `events.emit` capability and provider-owned self-event registration/draining through the real worker composition seam
- `/tests/providers/slack/ingress-response-stream.spec.ts`, `ingress-webhook-handler.spec.ts`, `ingress-routing.spec.ts`, `ingress-signature.spec.ts`, and `ingress-rate-limit.spec.ts`
  - native Slack stream behavior plus the unchanged authentication, filtering, routing, and ingress-rate boundaries around durable enqueue
- `/tests/identity-policy.spec.ts`
  - config parsing and missing-agent fail-closed behavior
  - GitHub repo normalization from HTTPS/SSH/git URL forms
  - sidecar schema, token-source precedence, token-file fallback
  - GitHub App installation-token minting
- `/tests/create-pull-request.spec.ts`
  - PR parameter validation
  - malformed repository input before secret resolution
  - successful GitHub API request and activity logging
  - GitHub/network/credential error behavior
  - no token exposure in tool output
- `/tests/repo-normalization.spec.ts`
  - repository reference normalization behavior
- `/tests/security.spec.ts`
  - redaction helpers
  - PR helper error redaction
  - push helper token env isolation, askpass behavior, cleanup, and output redaction

## Validation expectations by change type

| Change area | Minimum checks |
| --- | --- |
| Types/config/settings state | `pnpm typecheck`, `pnpm test -- tests/plugin.spec.ts tests/identity-policy.spec.ts tests/repo-normalization.spec.ts` if using targeted commands |
| GitHub App manifest flow | `pnpm typecheck`, `pnpm test -- tests/plugin.spec.ts`; manually review settings UI callback path if browser behavior changed |
| PR tool | `pnpm typecheck`, `pnpm test -- tests/create-pull-request.spec.ts tests/security.spec.ts` |
| Push tool | `pnpm typecheck`, `pnpm test -- tests/plugin.spec.ts tests/security.spec.ts` |
| Build/package metadata | `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm pack --pack-destination .` |

For a final pre-merge check, prefer:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack --pack-destination .
```

## CI and documentation automation

The active CI workflow source is `/.github/workflows/ci.yml`. It runs on pull requests and pushes to `main`, uses Node.js 24, enables `pnpm@10.17.1`, installs with `--frozen-lockfile`, then runs typecheck, tests, build, pack, packaged-output verification, and artifact upload.

Coding agents update affected OpenWiki pages in the same feature or behavior-change pull request as the code. GitHub Actions does not generate OpenWiki content or use a self-hosted documentation runner. A local or cloud coding agent may run weekly or manually to submit catch-up documentation as a normal reviewed pull request.

CI runs `pnpm docs:build` on pull requests and pushes to `main`; VitePress fails the build for broken internal links. The searchable static documentation site is built from the same `openwiki/` Markdown and published through `/.github/workflows/pages.yml`.

The README's CI section describes validation steps equivalent to local checks:

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm pack --pack-destination .`
- uploading the generated package tarball as an artifact

Documentation publishing uses:

```bash
pnpm docs:build
```

The Pages artifact is `openwiki/.vitepress/dist`. Author or generate OpenWiki Markdown directly in `openwiki/`; do not add post-generation folder moves.

## Release automation

`.github/workflows/release.yml` releases version changes merged to `main`:

- Every push to `main` compares the current `package.json` version with the previous commit. If unchanged, the workflow exits successfully without tagging or publishing.
- Version bumps are explicit normal pull-request changes. CI requires a canonical SemVer version greater than the base revision whenever `package.json` changes. Update the intended patch, minor, or major version in both `package.json` and `src/manifest.ts` before merging.
- When the version changed, the workflow verifies package/manifest parity, runs typecheck, tests, build, and pack, requires a greater stable version, then tags the exact merged SHA and creates a GitHub Release. Regular CI enforces package/manifest parity even when a release is skipped.
- `.github/workflows/publish.yml` receives that immutable stable tag and validates matching package/manifest versions before publishing. Each version publishes under `previous` first; after every publish run, the current `main` version is promoted to npm `latest` only once that exact version exists in the registry. It can be dispatched with `dry_run: true` to validate a tag without publication.
- The release workflow never increments versions and never writes to `main`. Publishing requires the repository `NPM_TOKEN` secret.

If changing release automation, inspect `.github/workflows/` directly and update README/OpenWiki together.

## Packaging checks

The package publishes only the files listed in `/package.json`:

- `dist`
- `README.md`
- `LICENSE`
- `pnpm-lock.yaml`

After packing, inspect tarball contents to confirm `dist/manifest.js`, `dist/worker.js`, and `dist/ui/index.js` are present. The README gives an example using `tar -tzf`.

## Operational security notes

- Do not read or commit real credential sidecar files, private keys, token files, `.env` files, or secrets.
- Tests set `PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS` to temporary files; the runtime default is `<os.homedir()>/.paperclip/agent-identities/credentials.json`.
- GitHub App private key files generated by manifest conversion are written with mode `0600`.
- Tool changes should preserve tests proving denial paths happen before secret resolution and that outputs redact tokens.
- Browser-side settings UI propagation to `/api/agents/<id>` is not covered by the current Node tests; use manual validation when changing it.
