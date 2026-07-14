import { describe, it, expect } from "vitest";
import { routeSlackEventToAgent } from "../../../src/providers/slack/ingress/routing.js";
import type { SlackAgentIdentity } from "../../../src/providers/slack/config.js";

function identity(overrides: Partial<SlackAgentIdentity> = {}): SlackAgentIdentity {
  return {
    label: "Agent",
    teamId: "T111",
    appId: "A111",
    botUserId: "U111",
    ...overrides,
  };
}

describe("routeSlackEventToAgent", () => {
  it("routes to the single agent matching both appId and teamId", () => {
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": identity({ teamId: "T111", appId: "A111" }),
      "agent-2": identity({ teamId: "T222", appId: "A222" }),
    };

    const result = routeSlackEventToAgent(identities, { appId: "A111", teamId: "T111" });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.agentId).toBe("agent-1");
  });

  it("fails closed when no agent matches", () => {
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": identity({ teamId: "T111", appId: "A111" }),
    };

    const result = routeSlackEventToAgent(identities, { appId: "A999", teamId: "T999" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no agent/i);
  });

  it("fails closed on ambiguity when appId+teamId matches more than one agent", () => {
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": identity({ teamId: "T111", appId: "A111" }),
      "agent-2": identity({ teamId: "T111", appId: "A111" }),
    };

    const result = routeSlackEventToAgent(identities, { appId: "A111", teamId: "T111" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/ambiguous|multiple/i);
  });

  it("does not match on appId alone when teamId differs", () => {
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": identity({ teamId: "T111", appId: "A111" }),
    };

    const result = routeSlackEventToAgent(identities, { appId: "A111", teamId: "T999" });

    expect(result.ok).toBe(false);
  });

  it("does not match on teamId alone when appId differs", () => {
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": identity({ teamId: "T111", appId: "A111" }),
    };

    const result = routeSlackEventToAgent(identities, { appId: "A999", teamId: "T111" });

    expect(result.ok).toBe(false);
  });

  it("fails closed on empty appId or teamId input", () => {
    const identities: Record<string, SlackAgentIdentity> = {
      "agent-1": identity({ teamId: "T111", appId: "A111" }),
    };

    expect(routeSlackEventToAgent(identities, { appId: "", teamId: "T111" }).ok).toBe(false);
    expect(routeSlackEventToAgent(identities, { appId: "A111", teamId: "" }).ok).toBe(false);
  });
});
