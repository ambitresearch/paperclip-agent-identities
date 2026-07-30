import type {
  ProviderSettingsAdapter,
  ProviderSettingsValidation,
} from "../../core/provider-settings-contract.js";
// Deliberately NOT importing from "./index.js" (the github provider's
// server-side composition, which pulls in app-manifest.ts's `node:crypto`
// usage and the full worker tool surface) -- this module is imported by the
// client-side Settings UI bundle (src/ui/SettingsPage.tsx ->
// src/providers/index.ts -> this file), so it must only depend on
// UI-safe/isomorphic modules. The provider id literal is duplicated here
// (rather than imported from github/index.ts's GITHUB_PROVIDER_ID) to keep
// this adapter's only dependency the UI contract type -- matching the
// "module-local constant" pattern github/index.ts itself uses.
const GITHUB_SETTINGS_PROVIDER_ID = "github";

export const githubSettingsAdapter: ProviderSettingsAdapter = {
  providerId: GITHUB_SETTINGS_PROVIDER_ID,
  formSteps: [
    { id: "identity", label: "Identity" },
    { id: "github", label: "GitHub App" },
    { id: "commit", label: "Commit" },
  ],
  credentialStepId: "github",
  savesViaSeparateAction: false,
  hasProviderAccountFieldsInIdentityStep: true,
  getValidation(config, hasDuplicate, extra): ProviderSettingsValidation {
    const missingSecretIds = extra?.missingSecretIds ?? new Set<string>();
    const hasIdentity =
      Boolean(config.agentId.trim() && config.provider.trim() && config.label.trim() && config.githubUsername.trim()) &&
      !hasDuplicate;
    // A selected private-key/fallback-token secret ref that no longer
    // resolves to a real secret (DRO-1155) must not count toward a
    // complete credential -- otherwise the UI shows a missing-secret error
    // next to the field while still letting that stale ref be saved.
    const privateKeySecretMissing = Boolean(
      config.privateKeySecretId.trim() && missingSecretIds.has(config.privateKeySecretId.trim()),
    );
    const fallbackTokenSecretMissing = Boolean(
      config.fallbackTokenSecretId.trim() && missingSecretIds.has(config.fallbackTokenSecretId.trim()),
    );
    const hasGitHubAppCredential = Boolean(
      config.githubAppId.trim() &&
        config.githubInstallationId.trim() &&
        ((config.privateKeySecretId.trim() && !privateKeySecretMissing) || config.privateKeyFile.trim()),
    );
    const hasFallbackCredential = Boolean(
      (config.fallbackTokenSecretId.trim() && !fallbackTokenSecretMissing) || config.tokenFile.trim(),
    );
    const identityComplete = hasIdentity;
    const credentialComplete = hasGitHubAppCredential || hasFallbackCredential;
    const identityMessage = hasDuplicate
      ? "This agent already has an identity for the selected provider. Edit the existing identity instead."
      : !hasIdentity
        ? "Choose an agent, provider, label, and provider username before continuing."
        : "Identity details are complete.";
    const credentialMessage = credentialComplete
      ? "Credential source is complete."
      : privateKeySecretMissing || fallbackTokenSecretMissing
        ? "The selected secret no longer exists. Choose another secret or refresh secrets before this identity can be saved."
        : "Add a complete GitHub App credential, or choose a fallback token source, before this identity can be saved.";
    const saveMessage = !identityComplete
      ? identityMessage
      : !credentialComplete
        ? credentialMessage
        : "Required setup is complete. Review optional commit metadata, then save.";
    return {
      identityComplete,
      credentialComplete,
      isComplete: identityComplete && credentialComplete,
      identityMessage,
      credentialMessage,
      saveMessage,
    };
  },
};
