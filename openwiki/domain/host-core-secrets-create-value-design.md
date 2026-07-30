# Host-core capability design: `secrets.create-value` (DRO-1175)

Status: **declined, won't-do (2026-07-29).** Roshan answered option C ("don't") on the DRO-1175
interaction; DRO-1175 and its parent, DRO-1157, were both closed won't-do the same day. This
capability will not be built. The manual two-step operator flow (create the company secret, paste
its UUID into the identity dialog — see
[Slack Provisioning Decision Record](/domain/slack-provisioning-decision)) is the standing,
permanent state. The design below is retained as a reference artifact only, in case the question
is reopened in the future. This capability lives in Paperclip host-core
(`paperclipai/paperclip`, `server/` package — `PluginSecretsClient` / `plugin-capability-validator`
/ `plugin-secrets-handler`), not in this plugin repo. This repo (`paperclip-agent-identities`) has
no write access to host-core source; this document is the technical spec to hand to whoever owns
that repo, produced so DRO-1157 (Slack secret auto-provisioning) has a concrete target to build
against once it ships.

## Problem recap

Confirmed against `@paperclipai/plugin-sdk` types (mirrored in `src/plugin-sdk-secure-config.d.ts`)
and the host's `plugin-capability-validator`:

- `ctx.config.patchSecretRefs` — binds an **existing** `{type: "secret_ref", secretId, version?}`
  into plugin config. Requires `secrets.bind-ref`. No raw-value intake.
- `ctx.secrets.resolve` — reads an **existing** secret's value. Requires `secrets.read-ref`. No
  write path.

(Both `secrets.bind-ref` and `secrets.read-ref` are supported by the running host but absent from
the published `PLUGIN_CAPABILITIES` union in `@paperclipai/shared` as of this writing — this repo's
manifest declares them with an explicit "host supports this ahead of the published SDK type union"
cast; see `src/manifest.ts:197`.)

No capability lets a plugin mint a brand-new company-scoped secret record from a value it holds in
memory (e.g. a Slack `oauth.v2.access` bot token or signing secret received in an OAuth callback
handler). That is the gap DRO-1157 is blocked on.

## Proposed capability: `secrets.create-value`

### SDK surface (`PluginSecretsClient`, alongside `resolve`)

```ts
interface PluginSecretsClient {
  resolve(...): Promise<string>; // existing

  /**
   * Server-side-only: create a new company-scoped secret from a raw value the
   * plugin currently holds in memory. Returns an opaque secret ref; never
   * echoes the value back.
   */
  createValue(input: {
    companyId?: string;          // defaults to the caller's bound company scope
    value: string;                // raw secret value, plugin-held (e.g. OAuth token)
    label?: string;                // human-readable label for the secrets UI (no value leakage)
    idempotencyKey: string;        // required — see idempotency below
  }): Promise<{ type: "secret_ref"; secretId: string; version: string }>;
}
```

### Required capability declaration

`secrets.create-value` — new entry in `PluginCapability` (shared package) and
`OPERATION_CAPABILITIES` in `plugin-capability-validator`, distinct from `secrets.bind-ref` and
`secrets.read-ref` so a plugin must opt in explicitly (manifest review surfaces "this plugin can
mint new secrets" separately from "this plugin can read/bind secrets you already created").

### Server-side contract (`plugin-secrets-handler` equivalent for writes)

1. **Value never round-trips.** Request carries the raw value in the plugin→host bridge call
   (already trusted transport, same as today's config/webhook payloads); response contains only
   `{secretId, version}`. The value must not be logged, echoed in error messages, or included in
   any audit record body (audit the *action* and *secretId*, not the value).
2. **Company/agent scoping enforced server-side**, not by trusting the plugin's `companyId` param
   blindly — same scoping model as `patchSecretRefs`/`resolve` (derive from the bound
   installation/session, not attacker-controlled input).
3. **Idempotent under retry.** Plugin-supplied `idempotencyKey` (e.g. derived from
   `{agentId}:{provider}:{credentialKind}` such as `slack-bot-token` /
   `slack-signing-secret`) must make retried calls resolve to the *same* secret record rather than
   minting duplicates on every OAuth callback retry/webhook redelivery. Store
   `(companyId, pluginId, idempotencyKey) -> secretId` and return the existing secret's ref
   (optionally rotating its value, an explicit follow-up decision) rather than erroring or
   double-creating.
4. **Rate-limited** the same way `plugin-secrets-handler`'s existing `createRateLimiter` gates
   resolution attempts, to bound abuse of a compromised/misbehaving plugin instance.
5. **No new secret round-trips through browser/UI.** The created secret must be immediately usable
   via the existing `secret_ref` plumbing (`patchSecretRefs`, host secrets UI listing) — it is a
   first-class company secret from creation, not a plugin-private construct.

### Non-goals for this capability (kept separate)

- Secret **rotation** of a previously-created value (update value, same `secretId`) — plausible
  follow-up capability (`secrets.rotate-value`), not required for DRO-1157's initial ask (Slack
  install is a one-time credential mint per agent).
- Secret **deletion** — out of scope; existing host UI/API already covers this for company admins.

## Consumer: how DRO-1157 would use this once shipped

In the Slack OAuth callback handler (`src/providers/slack/...`), after receiving
`oauth.v2.access`:

```ts
const botTokenRef = await ctx.secrets.createValue({
  value: oauthResponse.access_token,
  label: `Slack bot token — ${agentId}`,
  idempotencyKey: `${agentId}:slack:bot-token`,
});
const signingSecretRef = await ctx.secrets.createValue({
  value: appConfig.signingSecret,
  label: `Slack signing secret — ${agentId}`,
  idempotencyKey: `${agentId}:slack:signing-secret`,
});
await ctx.config.patchSecretRefs({
  path: ["identities", agentId, "slack", "credentials", "botToken"],
  value: botTokenRef,
});
await ctx.config.patchSecretRefs({
  path: ["identities", agentId, "slack", "credentials", "signingSecret"],
  value: signingSecretRef,
});
```

This removes the manual "operator creates two company secrets, pastes two UUIDs" step from
`slack-provisioning-decision.md`'s MVP flow, and lets the plugin signal completion + select the new
refs in the open identity dialog per DRO-1157's goal.

## Ownership and next step

This repo (`paperclip-agent-identities`) cannot implement or ship this — it lives in
`paperclipai/paperclip` host-core, a repository this plugin team does not own or have write
access to.

**Resolved 2026-07-29:** the question this section originally posed was asked and answered.
Roshan chose option C ("don't") on the [DRO-1175](https://paperclip.roshangautam.com/DRO/issues/DRO-1175)
interaction — this capability will not be built, and there is no further action or decision
pending here. This document stops being a live handoff artifact and becomes a reference spec only,
kept in case the question is reopened.
