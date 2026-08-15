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
that repo, should the decision be reopened.

## Problem recap

Confirmed against `@paperclipai/plugin-sdk` types (mirrored in `src/plugin-sdk-secure-config.d.ts`)
and the host's `plugin-capability-validator`:

- `ctx.config.patchSecretRefs` — binds an **existing** `{type: "secret_ref", secretId, version?}`
  into plugin config. Requires `secrets.bind-ref`. No raw-value intake.
- `ctx.secrets.resolve` — reads an **existing** secret's value. Requires `secrets.read-ref`. No
  write path.

(`secrets.bind-ref` is supported by the running host but absent from the published
`PLUGIN_CAPABILITIES` union in `@paperclipai/shared` as of this writing — this repo's manifest
declares it with an explicit "host supports this ahead of the published SDK type union" cast; see
the `"secrets.bind-ref"` entry in the `capabilities` array in `src/manifest.ts`. `secrets.read-ref`
is in the published union and needs no cast.)

No capability lets a plugin mint a brand-new company-scoped secret record from a value it holds in
memory. DRO-1157 needs this for two Slack credentials that arrive through two *different*
channels, not one: a bot token a server-side OAuth callback receives from `oauth.v2.access`, and a
signing secret that `oauth.v2.access` does not return at all — Slack only ever exposes it on the
app's Basic Information page (App Credentials), the same manual source
[slack-provisioning-decision.md](/domain/slack-provisioning-decision) already documents. That is
the gap DRO-1157 is blocked on: `secrets.create-value` would let a plugin mint a secret from
whichever of these two values it holds, but it does not by itself give a plugin the signing secret
to mint from — see the Consumer section below for what a caller would still need to do about that.

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

This capability only mints a secret from a value the plugin already holds — it does not give the
plugin either value. The two Slack credentials still arrive through two unrelated channels, so a
consumer needs both wired up separately:

1. **Bot token**, in the server-side Slack OAuth callback handler (`src/providers/slack/...`),
   after `oauth.v2.access` returns:

   ```ts
   const botTokenRef = await ctx.secrets.createValue({
     value: oauthResponse.access_token,
     label: `Slack bot token — ${agentId}`,
     idempotencyKey: `${agentId}:slack:bot-token`,
   });
   await ctx.config.patchSecretRefs({
     path: ["identities", agentId, "slack", "credentials", "botToken"],
     value: botTokenRef,
   });
   ```

2. **Signing secret**, which `oauth.v2.access` never returns — Slack only ever surfaces it on the
   app's Basic Information page. `secrets.create-value` removes the "paste it into a *Paperclip*
   company secret" half of that step, but the operator still has to copy the value out of Slack's
   UI and submit it once, through some plugin-owned intake (e.g. a one-time paste field in the
   identity dialog itself) that calls `createValue` on the operator's behalf:

   ```ts
   const signingSecretRef = await ctx.secrets.createValue({
     value: operatorSuppliedSigningSecret,
     label: `Slack signing secret — ${agentId}`,
     idempotencyKey: `${agentId}:slack:signing-secret`,
   });
   await ctx.config.patchSecretRefs({
     path: ["identities", agentId, "slack", "credentials", "signingSecret"],
     value: signingSecretRef,
   });
   ```

   The App Manifest API's `apps.manifest.export` does not return secrets either, so there is no
   Slack API path today that would let step 2 run without a human copying the value out of Slack's
   UI at least once — `secrets.create-value` shortens what happens to that value after the
   operator supplies it, not how the operator obtains it.

Even with both wired up, this removes the "operator creates two *Paperclip* company secrets and
pastes two UUIDs into the identity dialog" step from `slack-provisioning-decision.md`'s MVP flow,
and lets the plugin signal completion + select the new refs in the open identity dialog per
DRO-1157's goal — it does not remove the one Slack-side copy/paste for the signing secret.

## Ownership and next step

This repo (`paperclip-agent-identities`) cannot implement or ship this — it lives in
`paperclipai/paperclip` host-core, a repository this plugin team does not own or have write
access to.

**Resolved 2026-07-29:** the question this section originally posed was asked and answered.
Roshan chose option C ("don't") on the [DRO-1175](https://paperclip.roshangautam.com/DRO/issues/DRO-1175)
interaction — this capability will not be built, and there is no further action or decision
pending here. This document stops being a live handoff artifact and becomes a reference spec only,
kept in case the question is reopened.
