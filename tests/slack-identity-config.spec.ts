import { describe, expect, it } from "vitest";
import { normalizeSettingsState } from "../src/core/identity-config.js";

describe("Slack identity config (v4)", () => {
  it("normalizes a valid Slack identity entry with only shareable fields, no credential fields", () => {
    const raw = {
      version: 4,
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Agent One [Acme]",
          slack: {
            teamId: "T123",
            appId: "A123",
            botUserId: "U123",
            defaultChannel: "C123",
          },
        },
      },
    };

    const normalized = normalizeSettingsState(raw);
    const entry = normalized.identities["agent-1:slack"];
    expect(entry).toEqual({
      provider: "slack",
      id: "agent-1:slack",
      agentId: "agent-1",
      label: "Agent One [Acme]",
      slack: {
        teamId: "T123",
        appId: "A123",
        botUserId: "U123",
        defaultChannel: "C123",
      },
    });
    // No credential-shaped keys anywhere on the public config entry.
    expect(Object.keys((entry as { slack: object }).slack)).not.toContain("botToken");
    expect(JSON.stringify(entry)).not.toMatch(/token|secret/i);
  });

  it("omits the optional defaultChannel when absent", () => {
    const raw = {
      version: 4,
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Agent One",
          slack: { teamId: "T1", appId: "A1", botUserId: "U1" },
        },
      },
    };

    const normalized = normalizeSettingsState(raw);
    const entry = normalized.identities["agent-1:slack"];
    expect(entry).toEqual({
      provider: "slack",
      id: "agent-1:slack",
      agentId: "agent-1",
      label: "Agent One",
      slack: { teamId: "T1", appId: "A1", botUserId: "U1" },
    });
  });

  it("drops a Slack entry missing required shareable fields", () => {
    const raw = {
      version: 4,
      identities: {
        "agent-1:slack": {
          provider: "slack",
          id: "agent-1:slack",
          agentId: "agent-1",
          label: "Agent One",
          slack: { teamId: "", appId: "A1", botUserId: "U1" },
        },
      },
    };

    const normalized = normalizeSettingsState(raw);
    expect(normalized.identities["agent-1:slack"]).toBeUndefined();
  });
});
