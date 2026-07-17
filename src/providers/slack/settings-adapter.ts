import type {
  ProviderSettingsAdapter,
  ProviderSettingsValidation,
} from "../../core/provider-settings-contract.js";
// Deliberately NOT importing from "./index.js" (the slack provider's
// server-side composition, which pulls in app-manifest.ts's `node:crypto`
// usage) -- see the matching note in ../github/settings-adapter.ts. This
// module is imported by the client-side Settings UI bundle.
const SLACK_SETTINGS_PROVIDER_ID = "slack";

export const slackSettingsAdapter: ProviderSettingsAdapter = {
  providerId: SLACK_SETTINGS_PROVIDER_ID,
  formSteps: [
    { id: "identity", label: "Identity" },
    { id: "slack", label: "Slack App" },
  ],
  credentialStepId: "slack",
  savesViaSeparateAction: true,
  hasProviderAccountFieldsInIdentityStep: false,
  getValidation(config, hasDuplicate, extra): ProviderSettingsValidation {
    const slackSaveResult = extra.slackSaveResult ?? null;
    const slackSaveBusy = Boolean(extra.slackSaveBusy);
    const hasIdentity = Boolean(config.agentId.trim() && config.provider.trim() && config.label.trim()) && !hasDuplicate;
    const hasSlackInstallFields = Boolean(
      config.slackTeamId.trim() &&
        config.slackAppId.trim() &&
        config.slackBotUserId.trim() &&
        config.slackBotTokenSecretId.trim() &&
        config.slackSigningSecretId.trim(),
    );
    // The install metadata is only considered saved when save-slack-install-metadata
    // has actually completed for the CURRENT field values -- editing any Slack field
    // after a successful save invalidates that prior result, and a save still in
    // flight must not let the footer report completion early.
    const slackSaveMatchesCurrentFields = Boolean(
      slackSaveResult &&
        slackSaveResult.teamId === config.slackTeamId.trim() &&
        slackSaveResult.appId === config.slackAppId.trim() &&
        slackSaveResult.botUserId === config.slackBotUserId.trim() &&
        slackSaveResult.botTokenSecretId === config.slackBotTokenSecretId.trim() &&
        slackSaveResult.signingSecretId === config.slackSigningSecretId.trim() &&
        (slackSaveResult.defaultChannel ?? "") === config.slackDefaultChannel.trim(),
    );
    const hasSlackInstall = hasSlackInstallFields && slackSaveMatchesCurrentFields && !slackSaveBusy;
    const identityComplete = hasIdentity;
    const credentialComplete = hasSlackInstall;
    const identityMessage = hasDuplicate
      ? "This agent already has an identity for the selected provider. Edit the existing identity instead."
      : !hasIdentity
        ? "Choose an agent, provider, and label before continuing."
        : "Identity details are complete.";
    const credentialMessage = credentialComplete
      ? "Slack install metadata is complete."
      : slackSaveBusy
        ? "Saving Slack install metadata..."
        : "Create the Slack App manifest, install it, and paste back the team/app/bot IDs plus bot token and signing secret references, then save install metadata before this identity can be saved.";
    const saveMessage = !identityComplete
      ? identityMessage
      : !credentialComplete
        ? credentialMessage
        : "Required setup is complete.";
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
