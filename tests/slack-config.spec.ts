import { describe, expect, it } from "vitest";
import { validateSlackConfig, projectSlackPluginConfig } from "../src/providers/slack/config.js";
import type { AgentIdentityConfig } from "../src/core/identity-config.js";

function slackConfig(
  agentId: string,
  over: Partial<{ teamId: string; appId: string; botUserId: string; defaultChannel: string }> = {},
): AgentIdentityConfig {
  return {
    provider: "slack",
    id: `slack:${agentId}`,
    agentId,
    label: `Bot ${agentId}`,
    slack: {
      teamId: `T-${agentId}`,
      appId: `A-${agentId}`,
      botUserId: `U-${agentId}`,
      ...over,
    },
  } as AgentIdentityConfig;
}

describe("validateSlackConfig", () => {
  it("validates exactly one well-formed Slack identity", () => {
    const validated = validateSlackConfig({
      label: "Bot One",
      teamId: "T1",
      appId: "A1",
      botUserId: "U1",
    });
    expect(validated).toEqual({ label: "Bot One", teamId: "T1", appId: "A1", botUserId: "U1" });
  });

  it("returns a joined error string for missing required fields", () => {
    const result = validateSlackConfig({ label: "Bot One", teamId: "", appId: "A1", botUserId: "U1" });
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/teamId/);
  });

  it("returns an error string for wholly malformed metadata (not an object)", () => {
    expect(typeof validateSlackConfig("nope")).toBe("string");
    expect(typeof validateSlackConfig(null)).toBe("string");
    expect(typeof validateSlackConfig(undefined)).toBe("string");
  });

  it("returns an error string when required fields are the wrong type", () => {
    const result = validateSlackConfig({ label: "Bot", teamId: 123, appId: "A1", botUserId: "U1" });
    expect(typeof result).toBe("string");
  });
});

describe("projectSlackPluginConfig", () => {
  it("projects a v4 slack identity into the flat plugin-config shape keyed by agentId", () => {
    const projected = projectSlackPluginConfig({ sl: slackConfig("sl") });
    expect(projected).toEqual({
      sl: { label: "Bot sl", teamId: "T-sl", appId: "A-sl", botUserId: "U-sl" },
    });
  });

  it("includes defaultChannel when present and omits it when absent", () => {
    const withChannel = projectSlackPluginConfig({ sl: slackConfig("sl", { defaultChannel: "C1" }) });
    expect(withChannel.sl).toEqual({
      label: "Bot sl", teamId: "T-sl", appId: "A-sl", botUserId: "U-sl", defaultChannel: "C1",
    });

    const withoutChannel = projectSlackPluginConfig({ sl: slackConfig("sl") });
    expect(withoutChannel.sl).not.toHaveProperty("defaultChannel");
  });

  it("polymorphically filters out non-slack identities (wrong provider)", () => {
    const githubEntry = {
      provider: "github",
      id: "github:gh",
      agentId: "gh",
      label: "GH Bot",
      github: { username: "gh-bot" },
    };
    const projected = projectSlackPluginConfig({
      sl: slackConfig("sl"),
      gh: githubEntry as unknown as AgentIdentityConfig,
    });
    expect(Object.keys(projected)).toEqual(["sl"]);
  });

  it("drops entries with malformed slack metadata (missing/empty required fields)", () => {
    const projected = projectSlackPluginConfig({
      bad: slackConfig("bad", { teamId: "" }),
      good: slackConfig("good"),
    });
    expect(Object.keys(projected)).toEqual(["good"]);
  });

  it("drops entries where the slack metadata is not an object", () => {
    const malformed = {
      provider: "slack",
      id: "slack:m",
      agentId: "m",
      label: "Bot m",
      slack: "not-an-object",
    };
    const projected = projectSlackPluginConfig({ m: malformed as unknown as AgentIdentityConfig });
    expect(projected).toEqual({});
  });

  it("returns an empty object for empty input", () => {
    expect(projectSlackPluginConfig({})).toEqual({});
  });

  it("validates exactly one slack identity per agent even with multiple entries in the map", () => {
    const projected = projectSlackPluginConfig({
      a: slackConfig("a"),
      b: slackConfig("b"),
    });
    expect(Object.keys(projected).sort()).toEqual(["a", "b"]);
    expect(projected.a.teamId).toBe("T-a");
    expect(projected.b.teamId).toBe("T-b");
  });
});
