import { describe, it, expect } from "vitest";
import {
  getFormSteps,
  getIdentityFormValidation,
  toFormState,
  type IdentityFormState,
} from "../../src/ui/SettingsPage.js";
import { SLACK_IDENTITY_PROVIDER_ID, GITHUB_IDENTITY_PROVIDER_ID } from "../../src/shared/types.js";
import type { SaveSlackInstallMetadataResult } from "../../src/shared/types.js";

function slackConfig(overrides: Partial<IdentityFormState> = {}): IdentityFormState {
  return {
    ...toFormState(),
    provider: SLACK_IDENTITY_PROVIDER_ID,
    agentId: "agent-1",
    label: "Release Bot",
    slackTeamId: "T0123456789",
    slackAppId: "A0123456789",
    slackBotUserId: "U0123456789",
    slackDefaultChannel: "",
    slackEventsRequestUrl: "https://paperclip-test.trycloudflare.com/events",
    slackBotTokenSecretId: "11111111-1111-4111-8111-111111111111",
    slackSigningSecretId: "22222222-2222-4222-8222-222222222222",
    ...overrides,
  };
}

describe("Slack setup wizard: provider selection and steps", () => {
  it("shows the Slack-specific wizard steps (identity, Slack App) when the provider is slack", () => {
    const steps = getFormSteps(SLACK_IDENTITY_PROVIDER_ID);
    expect(steps.map((step) => step.id)).toEqual(["identity", "slack"]);
  });

  it("shows the GitHub wizard steps (identity, GitHub App, commit) for the github provider", () => {
    const steps = getFormSteps(GITHUB_IDENTITY_PROVIDER_ID);
    expect(steps.map((step) => step.id)).toEqual(["identity", "github", "commit"]);
  });

  it("restores saved Slack setup URL and secret UUID references into the edit form", () => {
    const form = toFormState({
      id: "agent-1:slack",
      agentId: "agent-1",
      provider: SLACK_IDENTITY_PROVIDER_ID,
      label: "Release Bot",
      slack: {
        teamId: "T0123456789",
        appId: "A0123456789",
        botUserId: "U0123456789",
      },
      slackSetup: {
        eventsRequestUrl: "https://paperclip-test.trycloudflare.com/events",
        botTokenSecretId: "11111111-1111-4111-8111-111111111111",
        signingSecretId: "22222222-2222-4222-8222-222222222222",
      },
      credentialStatus: "configured",
    });

    expect(form.slackEventsRequestUrl).toBe("https://paperclip-test.trycloudflare.com/events");
    expect(form.slackBotTokenSecretId).toBe("11111111-1111-4111-8111-111111111111");
    expect(form.slackSigningSecretId).toBe("22222222-2222-4222-8222-222222222222");
  });
});

describe("Slack setup wizard: manifest-create step gating", () => {
  it("does not consider the Slack credential step complete before any install metadata has been saved", () => {
    const validation = getIdentityFormValidation(slackConfig(), false, null, false);
    expect(validation.identityComplete).toBe(true);
    expect(validation.credentialComplete).toBe(false);
    expect(validation.isComplete).toBe(false);
  });

  it("reports the credential step as busy while a save-slack-install-metadata call is in flight", () => {
    const validation = getIdentityFormValidation(slackConfig(), false, null, true);
    expect(validation.credentialComplete).toBe(false);
    expect(validation.credentialMessage).toMatch(/Saving Slack install metadata/);
  });
});

describe("Slack setup wizard: paste-back form validation gating save completion", () => {
  it.each([
    ["bot token", { slackBotTokenSecretId: "" }],
    ["signing secret", { slackSigningSecretId: "" }],
  ])("gates completion when the required %s reference is missing", (_label, overrides) => {
    const incomplete = getIdentityFormValidation(slackConfig(overrides), false, null, false);
    expect(incomplete.credentialComplete).toBe(false);
  });

  it("is complete only once a save-slack-install-metadata result matches the current field values", () => {
    const config = slackConfig();
    const matchingResult: SaveSlackInstallMetadataResult = {
      agentId: config.agentId,
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: config.slackTeamId,
      appId: config.slackAppId,
      botUserId: config.slackBotUserId,
      botTokenSecretId: config.slackBotTokenSecretId,
      signingSecretId: config.slackSigningSecretId,
      status: "saved",
    };
    const validation = getIdentityFormValidation(config, false, matchingResult, false);
    expect(validation.credentialComplete).toBe(true);
    expect(validation.isComplete).toBe(true);
  });

  it("treats a stale save result (fields edited after saving) as incomplete", () => {
    const config = slackConfig();
    const staleResult: SaveSlackInstallMetadataResult = {
      agentId: config.agentId,
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: "T_DIFFERENT_TEAM",
      appId: config.slackAppId,
      botUserId: config.slackBotUserId,
      botTokenSecretId: config.slackBotTokenSecretId,
      signingSecretId: config.slackSigningSecretId,
      status: "saved",
    };
    const validation = getIdentityFormValidation(config, false, staleResult, false);
    expect(validation.credentialComplete).toBe(false);
    expect(validation.isComplete).toBe(false);
  });

  it("treats a save result whose bot token secret no longer matches the current field as incomplete", () => {
    // Regression coverage: if the operator changes only the secret selection
    // (e.g. after a save completes, or while a stale response is in
    // flight -- see handleSaveSlackInstallMetadata's generation guard), a
    // result that matches every OTHER public field must still not report
    // completion, since the sidecar was persisted with the OLD secret
    // reference.
    const config = slackConfig({ slackBotTokenSecretId: "22222222-2222-4222-8222-222222222222" });
    const resultForOldSecret: SaveSlackInstallMetadataResult = {
      agentId: config.agentId,
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: config.slackTeamId,
      appId: config.slackAppId,
      botUserId: config.slackBotUserId,
      botTokenSecretId: "11111111-1111-4111-8111-111111111111",
      signingSecretId: config.slackSigningSecretId,
      status: "saved",
    };
    const validation = getIdentityFormValidation(config, false, resultForOldSecret, false);
    expect(validation.credentialComplete).toBe(false);
    expect(validation.isComplete).toBe(false);
  });

  it("treats a save result whose signing secret no longer matches the current field as incomplete", () => {
    const config = slackConfig({ slackSigningSecretId: "33333333-3333-4333-8333-333333333333" });
    const resultForOldSecret: SaveSlackInstallMetadataResult = {
      agentId: config.agentId,
      provider: SLACK_IDENTITY_PROVIDER_ID,
      teamId: config.slackTeamId,
      appId: config.slackAppId,
      botUserId: config.slackBotUserId,
      botTokenSecretId: config.slackBotTokenSecretId,
      signingSecretId: "22222222-2222-4222-8222-222222222222",
      status: "saved",
    };
    const validation = getIdentityFormValidation(config, false, resultForOldSecret, false);
    expect(validation.credentialComplete).toBe(false);
    expect(validation.isComplete).toBe(false);
  });
});
