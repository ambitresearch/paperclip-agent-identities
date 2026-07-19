// The Settings-UI analogue of `provider-contract.ts` / `provider-registry.ts`.
// Those describe the *worker-side* tool surface each identity provider
// contributes; this describes the *operator Settings UI wizard* surface each
// provider contributes -- its wizard steps and per-step validation. Composed
// once in `src/providers/index.ts` alongside `ALL_PROVIDERS`, so
// `src/ui/SettingsPage.tsx` calls into a registry instead of branching on
// provider id string literals.
//
// Deliberately generic over the same `IdentityFormState`-shaped config the UI
// already uses (see `src/ui/SettingsPage.tsx`) rather than each provider's own
// `TIdentity` type from `provider-contract.ts` -- the wizard form holds fields
// for every provider at once (github + slack), so the adapter validates a
// subset of that shared shape rather than a narrowed provider-specific type.

export type ProviderSettingsFormSection = string;

export interface ProviderSettingsFormStep {
  readonly id: ProviderSettingsFormSection;
  readonly label: string;
}

export interface ProviderSettingsValidation {
  readonly identityComplete: boolean;
  readonly credentialComplete: boolean;
  readonly isComplete: boolean;
  readonly identityMessage: string;
  readonly credentialMessage: string;
  readonly saveMessage: string;
}

// The wizard form holds fields for every provider at once (github + slack),
// so this is the full set an adapter may read from -- a structural superset
// matching `IdentityFormState` in `src/ui/SettingsPage.tsx`. Kept here
// (rather than importing `IdentityFormState` from the UI module) so this
// contract has no dependency on the UI, avoiding a UI -> provider -> UI cycle.
export interface ProviderSettingsFormConfig {
  readonly agentId: string;
  readonly provider: string;
  readonly label: string;
  readonly githubUsername: string;
  readonly githubAppId: string;
  readonly githubInstallationId: string;
  readonly privateKeySecretId: string;
  readonly privateKeyFile: string;
  readonly fallbackTokenSecretId: string;
  readonly tokenFile: string;
  readonly slackTeamId: string;
  readonly slackAppId: string;
  readonly slackBotUserId: string;
  readonly slackDefaultChannel: string;
  readonly slackEventsRequestUrl: string;
  readonly slackBotTokenSecretId: string;
  readonly slackSigningSecretId: string;
  readonly slackLegacyCredentialStatus: string;
  readonly slackLegacySigningSecretRequired: string;
}

// Provider-specific async/in-flight state the shared component tracks (e.g.
// Slack's last save-install-metadata result + busy flag) that a pure function
// can't derive from `config` alone. Optional/union-friendly since most
// providers (e.g. GitHub) need none of it.
export interface ProviderSettingsValidationExtra {
  readonly slackSaveResult?: {
    teamId: string;
    appId: string;
    botUserId: string;
    eventsRequestUrl: string;
    botTokenSecretId: string;
    signingSecretId: string;
    defaultChannel?: string | null;
  } | null;
  readonly slackSaveBusy?: boolean;
}

export interface ProviderSettingsAdapter {
  readonly providerId: string;
  /** Ordered wizard steps shown for this provider (after the shared "identity" step). */
  readonly formSteps: readonly ProviderSettingsFormStep[];
  /**
   * The step id (from `formSteps`) that holds this provider's
   * credential/setup fields -- e.g. `"github"` or `"slack"`. Used by the
   * shared wizard to know which step to jump back to when save-time
   * validation fails on the credential half of the form, without the
   * component itself branching on provider id.
   */
  readonly credentialStepId: ProviderSettingsFormSection;
  /**
   * True when this provider persists its identity via its own dedicated
   * action (e.g. Slack's save-slack-install-metadata) rather than the shared
   * save-bot-identity-config action. When true, reaching the final wizard
   * step with `isComplete` means that dedicated action has already run, so
   * the shared "Save agent" step just closes the wizard instead of calling
   * save-bot-identity-config.
   */
  readonly savesViaSeparateAction: boolean;
  /**
   * True when the shared "Identity" step should also render this provider's
   * inline account field(s) (e.g. GitHub's username field). False when the
   * provider account details live entirely in the provider's own credential
   * step (e.g. Slack's "Slack App" step).
   */
  readonly hasProviderAccountFieldsInIdentityStep: boolean;
  getValidation(
    config: ProviderSettingsFormConfig,
    hasDuplicate: boolean,
    extra: ProviderSettingsValidationExtra,
  ): ProviderSettingsValidation;
}

export interface ProviderSettingsRegistry {
  /** Look up the adapter for a provider id, falling back to `defaultProviderId`'s adapter if unknown. */
  get(providerId: string): ProviderSettingsAdapter;
  all(): readonly ProviderSettingsAdapter[];
}

export function buildProviderSettingsRegistry(
  adapters: readonly ProviderSettingsAdapter[],
  defaultProviderId: string,
): ProviderSettingsRegistry {
  const ordered = [...adapters];
  const byId = new Map(ordered.map((adapter) => [adapter.providerId, adapter] as const));
  const fallback = byId.get(defaultProviderId) ?? ordered[0];
  if (!fallback) {
    throw new Error("buildProviderSettingsRegistry: at least one adapter is required");
  }
  return {
    get(providerId: string): ProviderSettingsAdapter {
      return byId.get(providerId) ?? fallback;
    },
    all(): readonly ProviderSettingsAdapter[] {
      return ordered;
    },
  };
}
