// The React-rendering analogue of `provider-settings-contract.ts`. That file
// describes a provider's wizard steps + pure validation; this describes the
// provider's actual credential-step UI -- the local state/refs/effects/
// handlers a provider needs to render its own fieldset, plus the JSX itself.
//
// Composed by a per-provider "settings-adapter-ui.tsx" module (client code,
// may import React/hooks/JSX -- unlike settings-adapter.ts which must stay
// UI-safe but framework-agnostic) and looked up via a small registry in
// `src/providers/settings-ui-index.ts`, mirroring how
// `provider-settings-contract.ts` adapters are looked up via
// `settings-index.ts`. This lets `src/ui/SettingsPage.tsx` mount the active
// provider's credential step without branching on provider id strings.
import type { ComponentType } from "react";
import type { ProviderSettingsValidationExtra } from "./provider-settings-contract.js";

// Minimal shared surface the UI adapter's hook needs from SettingsPage. Kept
// intentionally small and structural (not importing IdentityFormState
// directly) to avoid a UI -> provider -> UI import cycle; providers depend on
// this contract module, not on SettingsPage.tsx.
export interface ProviderSettingsUIFormConfig {
  readonly agentId: string;
  readonly provider: string;
  readonly label: string;
  readonly previousAgentId: string;
  readonly slackTeamId: string;
  readonly slackAppId: string;
  readonly slackBotUserId: string;
  readonly slackDefaultChannel: string;
  readonly slackBotTokenSecretId: string;
}

export interface ProviderSettingsUIHookInput<TConfig extends ProviderSettingsUIFormConfig> {
  /** The current wizard form config, or null when no identity dialog is open. */
  readonly config: TConfig | null;
  /** Update a single form field, mirroring SettingsPage's `updateField`. */
  readonly updateField: (field: keyof TConfig & string, value: string) => void;
  /** Re-fetch identities/config after a mutation (mirrors usePluginData's `refresh`). */
  readonly refresh: () => void;
  /** The `delete-bot-identity-config` plugin action, used to clean up a renamed identity's stale row. */
  readonly deleteConfig: (input: Record<string, unknown>) => Promise<unknown>;
  /** Patch form state after a successful save (e.g. recording the just-saved agentId as `previousAgentId`). */
  readonly patchFormState: (patch: (prev: TConfig) => TConfig) => void;
  readonly secretOptions: ReadonlyArray<{ id: string; name: string; key?: string; description?: string; provider?: string; status?: string }>;
  readonly secretsLoading: boolean;
  readonly secretsError: string | null;
  readonly companyId: string;
}

// Whatever a provider's hook returns must include enough for the shared page
// to gate the "Next"/"Save" footer buttons and to reset provider-owned state
// from `startCreate`/`startEdit`/agentId-or-label-change -- everything else
// (busy flags, manifest state, error strings, JSX props) is provider-owned
// and opaque to SettingsPage.
export interface ProviderSettingsUIHookResult {
  /** Matches `ProviderSettingsAdapter.getValidation`'s `extra` parameter. */
  readonly validationExtra: ProviderSettingsValidationExtra;
  /**
   * Reset all provider-owned local state (busy flags, manifest flow, errors,
   * generation counters). Called by the shared page on startCreate,
   * startEdit, and whenever the agentId or label field changes.
   */
  readonly reset: () => void;
}

export interface ProviderSettingsUIAdapter<
  TConfig extends ProviderSettingsUIFormConfig = ProviderSettingsUIFormConfig,
  THookResult extends ProviderSettingsUIHookResult = ProviderSettingsUIHookResult,
  // Providers whose credential step needs its own dedicated worker actions
  // (e.g. Slack's create-slack-app-manifest / get-slack-app-manifest-flow /
  // save-slack-install-metadata) extend the hook input with those action
  // callables. usePluginAction must be called at a component's top level, so
  // SettingsPage calls it and threads the callables in here rather than this
  // module importing plugin-sdk itself.
  THookInput extends ProviderSettingsUIHookInput<TConfig> = ProviderSettingsUIHookInput<TConfig>,
> {
  readonly providerId: string;
  /** Hook capturing this provider's credential-step local state + handlers. */
  useCredentialStep(input: THookInput): THookResult;
  /** Renders this provider's credential-step fieldset JSX, given the hook's result. */
  readonly CredentialStep: ComponentType<{ state: THookResult; config: TConfig }>;
}

// Each provider's UI adapter is generic over its own config/hook-result/
// hook-input shape (e.g. Slack's manifest flow + secret fields), so a
// registry holding adapters for *every* provider at once can't be typed any
// more precisely than `any` here without erasing the very generics each
// adapter module relies on -- callers narrow via a same-module cast (see
// SettingsPage.tsx's use of `SlackSettingsUIFormConfig`) the same way the
// existing `ProviderSettingsAdapter` registry callers narrow with `as`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyProviderSettingsUIAdapter = ProviderSettingsUIAdapter<any, any, any>;

export interface ProviderSettingsUIRegistry {
  get(providerId: string): AnyProviderSettingsUIAdapter | undefined;
}

export function buildProviderSettingsUIRegistry(
  adapters: readonly AnyProviderSettingsUIAdapter[],
): ProviderSettingsUIRegistry {
  const byId = new Map(adapters.map((adapter) => [adapter.providerId, adapter] as const));
  return {
    get(providerId: string): AnyProviderSettingsUIAdapter | undefined {
      return byId.get(providerId);
    },
  };
}
