import { describe, it, expect } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  parseGitHubBotIdentityPluginConfig,
  resolveAgentIdentityFromToolRunContext
} from "../src/providers/github/config.js";

const baseRunCtx: ToolRunContext = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
  projectId: "project-1"
};

describe("parseGitHubBotIdentityPluginConfig", () => {
  it("parses a valid config into identities", () => {
    const config = parseGitHubBotIdentityPluginConfig({
      identities: {
        "agent-1": {
          label: "Release Bot",
          githubUsername: "release-bot",
          commitName: "Release Bot",
          commitEmail: "bot@example.com"
        }
      }
    });

    expect(config.identities["agent-1"]).toEqual({
      label: "Release Bot",
      githubUsername: "release-bot",
      commitName: "Release Bot",
      commitEmail: "bot@example.com"
    });
  });

  it("throws when an identity is missing required fields", () => {
    expect(() =>
      parseGitHubBotIdentityPluginConfig({ identities: { "agent-1": { label: "" } } })
    ).toThrow();
  });
});

describe("resolveAgentIdentityFromToolRunContext", () => {
  it("resolves the identity for the run context agent", () => {
    const resolved = resolveAgentIdentityFromToolRunContext(
      {
        identities: {
          "agent-1": {
            label: "Release Bot",
            githubUsername: "release-bot",
            commitName: "Release Bot",
            commitEmail: "bot@example.com"
          }
        }
      },
      baseRunCtx
    );

    expect(resolved).toEqual({
      agentId: "agent-1",
      identity: {
        label: "Release Bot",
        githubUsername: "release-bot",
        commitName: "Release Bot",
        commitEmail: "bot@example.com"
      }
    });
  });

  it("keeps optional commit fields absent when not provided", () => {
    const resolved = resolveAgentIdentityFromToolRunContext(
      {
        identities: {
          "agent-1": {
            label: "Release Bot",
            githubUsername: "release-bot"
          }
        }
      },
      baseRunCtx
    );

    expect(resolved.identity).toEqual({
      label: "Release Bot",
      githubUsername: "release-bot"
    });
  });

  it("throws a descriptive error when the agent has no identity", () => {
    expect(() =>
      resolveAgentIdentityFromToolRunContext(
        { identities: { "other-agent": { label: "X", githubUsername: "x" } } },
        baseRunCtx
      )
    ).toThrow("Missing agent identity config for agent 'agent-1'");
  });

  it("throws an invalid-config error when the config fails validation", () => {
    expect(() =>
      resolveAgentIdentityFromToolRunContext({ identities: "nope" }, baseRunCtx)
    ).toThrow("Invalid agent identity config:");
  });
});
