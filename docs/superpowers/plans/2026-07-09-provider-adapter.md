# Provider-adapter refactor plan (2026-07-09)

## Context

`paperclip-agent-identities` currently hard-codes GitHub-specific identity,
credential, and tool logic across `src/worker.ts`, `src/config-source.ts`,
`src/identity-policy.ts`, and `src/credential-sidecar.ts`. The provider list in
`src/shared/types.ts` (`SUPPORTED_IDENTITY_PROVIDERS`) is static UI metadata
only — there is no runtime registry that other modules can query or extend.

This plan decomposes the refactor into small, independently shippable tasks
(GitHub issues #25-#44 in this repo, milestone "Adapter Core") that migrate the
plugin toward a provider-adapter architecture without breaking the existing
GitHub-only behavior. Each task is TDD'd independently; later tasks build on
earlier ones but are not blocked from landing incrementally as long as the
existing GitHub path keeps passing `pnpm test` and `pnpm typecheck`.

## Task: Provider registry (issue #26)

Depends conceptually on issue #25 (Core provider contracts), which defines the
shape of a provider adapter. Since no adapter contract exists yet in this
repo, this task introduces the minimal contract and the registry together,
scoped narrowly so later tasks (config projection, credential adapter, tool
specs) can extend it without a breaking change.

### Goal

Add a runtime provider registry module that:

- Defines a `ProviderAdapter` contract: `{ id: IdentityProviderId, definition: IdentityProviderDefinition }`
  (re-using the existing `IdentityProviderId` / `IdentityProviderDefinition`
  types from `src/shared/types.ts` — no changes to that file required).
- Exposes `registerProvider`, `getProvider`, `hasProvider`, and `listProviders`
  functions backed by a module-level registry.
- Seeds the registry at import time with adapters for every entry in
  `SUPPORTED_IDENTITY_PROVIDERS`, so existing behavior (GitHub enabled, others
  "coming-soon") is unchanged and observable through the new API.
- Throws on duplicate registration (`registerProvider` called twice for the
  same `id`) and on lookup of an unknown id via `getProvider`, matching the
  fail-closed conventions already used in `identity-policy.ts` and
  `credential-sidecar.ts`.
- Does not change `dist`, secrets, manifest, or worker wiring — this is a new,
  additive module consumed by later tasks (#38 "GitHub provider assembly",
  #40 "Provider composition root", #41 "Manifest registry composition", #42
  "Worker provider loop").

### Implementation

- New file: `src/providers/registry.ts`.
- New test file: `tests/provider-registry.spec.ts`.
- No changes to `src/worker.ts`, `src/manifest.ts`, or any existing tool
  behavior in this task — wiring the registry into the worker is deferred to
  issue #42 ("Worker provider loop").

### Validation

- Task-specific Vitest command: `pnpm exec vitest run tests/provider-registry.spec.ts`
- `pnpm test`
- `pnpm typecheck`

## Follow-on tasks (not implemented in this task)

Issues #25, #27-#44 cover the remaining contract, adapter, tool-spec, and
composition-root work. Each should get its own plan section added here when
it is picked up, so the plan stays the single source of truth referenced by
every issue's acceptance criteria.
