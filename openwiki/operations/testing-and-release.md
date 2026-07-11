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

Tests run with Vitest in Node environment. `/vitest.config.ts` includes `tests/**/*.spec.ts`.

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

`.github/workflows/release.yml` creates public releases from `main` while honoring the repository's pull-request rule:

- Every qualifying push to `main` creates a release pull request for the next patch version. It updates `package.json`, `pnpm-lock.yaml`, and `src/manifest.ts` together, then validates the package.
- The workflow waits for the automatic Copilot review to finish with zero open review threads and for all pull-request checks to pass before squash-merging the release PR.
- Only after the clean release PR merges does the workflow tag the merged commit, create a GitHub Release, and dispatch npm publication of that immutable tag. Comments or failed checks leave the release PR open and prevent tagging or publication.
- The release-generated commit is excluded from the automatic trigger, preventing a release loop. Minor and major releases are manual only. Run **Create Release** with `bump: minor` or `bump: major` from GitHub Actions.
- `.github/workflows/publish.yml` publishes only a stable release tag whose tag and `package.json` version match. It can also be dispatched with `dry_run: true` to validate npm packaging without publication.
- Both workflows re-run typecheck, tests, and the production build before publication. Publishing requires the repository `NPM_TOKEN` secret.

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
- Tests set `PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS` to temporary files; production default is `/paperclip/.paperclip/agent-identities/credentials.json`.
- GitHub App private key files generated by manifest conversion are written with mode `0600`.
- Tool changes should preserve tests proving denial paths happen before secret resolution and that outputs redact tokens.
- Browser-side settings UI propagation to `/api/agents/<id>` is not covered by the current Node tests; use manual validation when changing it.
