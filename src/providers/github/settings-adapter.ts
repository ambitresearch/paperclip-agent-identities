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
  getValidation(config, hasDuplicate): ProviderSettingsValidation {
    const hasIdentity =
      Boolean(config.agentId.trim() && config.provider.trim() && config.label.trim() && config.githubUsername.trim()) &&
      !hasDuplicate;
    const hasGitHubAppCredential = Boolean(
      config.githubAppId.trim() &&
        config.githubInstallationId.trim() &&
        (config.privateKeySecretId.trim() || config.privateKeyFile.trim()),
    );
    const hasFallbackCredential = Boolean(config.fallbackTokenSecretId.trim() || config.tokenFile.trim());
    const identityComplete = hasIdentity;
    const credentialComplete = hasGitHubAppCredential || hasFallbackCredential;
    const identityMessage = hasDuplicate
      ? "This agent already has an identity for the selected provider. Edit the existing identity instead."
      : !hasIdentity
        ? "Choose an agent, provider, label, and provider username before continuing."
        : "Identity details are complete.";
    const credentialMessage = credentialComplete
      ? "Credential source is complete."
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
