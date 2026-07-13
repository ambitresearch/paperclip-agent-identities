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
    slackBotTokenSecretId: "11111111-1111-4111-8111-111111111111",
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
  it("gates completion on all required paste-back fields being present", () => {
    const incomplete = getIdentityFormValidation(slackConfig({ slackBotTokenSecretId: "" }), false, null, false);
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
      status: "saved",
    };
    const validation = getIdentityFormValidation(config, false, staleResult, false);
    expect(validation.credentialComplete).toBe(false);
    expect(validation.isComplete).toBe(false);
  });
});
