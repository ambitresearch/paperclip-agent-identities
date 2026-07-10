import { describe, expect, it } from "vitest";
import {
  BOT_IDENTITY_SETTINGS_VERSION,
  migrateSettingsStateToV4,
  normalizeSettingsState,
  type AgentIdentitySettingsState,
} from "../src/core/identity-config.js";

describe("identity-config v4 migration", () => {
  it("exposes version 4", () => {
    expect(BOT_IDENTITY_SETTINGS_VERSION).toBe(4);
  });

  it("lifts flat v3 github fields into the nested github sub-object", () => {
    const v3 = {
      version: 3,
      identities: {
        "agent-1:github": {
          id: "agent-1:github",
          agentId: "agent-1",
          provider: "github",
          label: "Release Bot",
          githubUsername: "release-bot",
          commitName: "Release Bot",
          commitEmail: "bot@example.com",
          githubAppCredentialPropagationAgentIds: ["agent-2"],
        },
      },
    };

    const migrated = migrateSettingsStateToV4(v3);

    expect(migrated.version).toBe(4);
    const entry = migrated.identities["agent-1:github"];
    expect(entry).toEqual({
      provider: "github",
      id: "agent-1:github",
      agentId: "agent-1",
      label: "Release Bot",
      github: {
        username: "release-bot",
        commitName: "Release Bot",
        commitEmail: "bot@example.com",
        app: { credentialPropagationAgentIds: ["agent-2"] },
      },
    });
  });

  it("omits optional github fields when the v3 entry lacks them", () => {
    const migrated = migrateSettingsStateToV4({
      version: 3,
      identities: {
        "agent-1:github": {
          id: "agent-1:github",
          agentId: "agent-1",
          provider: "github",
          label: "Bot",
          githubUsername: "bot",
        },
      },
    });

    expect(migrated.identities["agent-1:github"]).toEqual({
      provider: "github",
      id: "agent-1:github",
      agentId: "agent-1",
      label: "Bot",
      github: { username: "bot" },
    });
  });

  it("passes a well-formed v4 state through normalizeSettingsState unchanged", () => {
    const v4: AgentIdentitySettingsState = {
      version: 4,
      identities: {
        "agent-1:github": {
          provider: "github",
          id: "agent-1:github",
          agentId: "agent-1",
          label: "Bot",
          github: { username: "bot" },
        },
      },
    };

    expect(normalizeSettingsState(v4)).toEqual(v4);
  });

  it("resets unknown/garbage input to an empty v4 state", () => {
    expect(normalizeSettingsState(null)).toEqual({ version: 4, identities: {} });
    expect(normalizeSettingsState({ version: 2 })).toEqual({ version: 4, identities: {} });
    expect(normalizeSettingsState({ nope: true })).toEqual({ version: 4, identities: {} });
  });

  it("drops malformed v4 entries rather than returning unvalidated persisted data", () => {
    expect(normalizeSettingsState({
      version: 4,
      identities: {
        broken: null,
        missingGithubUsername: {
          provider: "github", id: "agent-1:github", agentId: "agent-1", label: "Bot", github: {}
        }
      }
    })).toEqual({ version: 4, identities: {} });
  });

  it("routes a v3 payload through the ladder into v4", () => {
    const normalized = normalizeSettingsState({
      version: 3,
      identities: {
        "agent-1:github": {
          id: "agent-1:github",
          agentId: "agent-1",
          provider: "github",
          label: "Bot",
          githubUsername: "bot",
        },
      },
    });

    expect(normalized.version).toBe(4);
    expect(normalized.identities["agent-1:github"].provider).toBe("github");
  });
});
