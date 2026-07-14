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

OpenWiki documentation automation lives in `/.github/workflows/openwiki-update.yml`. It runs on pushes to `main` using a self-hosted runner and opens a pull request containing regenerated `openwiki/` and `AGENTS.md` changes. The searchable static documentation site is built from the same `openwiki/` Markdown by VitePress and published through `/.github/workflows/pages.yml`.

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

The Pages artifact is `openwiki/.vitepress/dist`. OpenWiki itself still writes Markdown to `openwiki/`; do not add post-generation folder moves.

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
