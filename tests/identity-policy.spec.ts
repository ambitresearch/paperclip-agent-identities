import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  evaluateRepoPolicy,
  normalizeGitHubRepoRef,
  parseGitHubBotIdentityPluginConfig,
  resolveAgentIdentityFromToolRunContext
} from "../src/identity-policy.js";

const baseRunCtx: ToolRunContext = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
  projectId: "project-1"
};

describe("github identity config", () => {
  it("resolves configured agent identity and applies default owner pattern", () => {
    const resolved = resolveAgentIdentityFromToolRunContext(
      {
        identities: {
          "agent-1": {
            label: "Default Bot",
            githubUsername: "roshan-bot",
            tokenSecretRef: "secret://github/token"
          }
        }
      },
      baseRunCtx
    );

    expect(resolved.identity.allowedOwnerPatterns).toEqual(["^roshangautam$"]);
  });

  it("fails closed when calling agent has no config", () => {
    expect(() =>
      resolveAgentIdentityFromToolRunContext(
        {
          identities: {
            "agent-other": {
              label: "Other Bot",
              githubUsername: "other-bot",
              tokenSecretRef: "secret://github/other"
            }
          }
        },
        baseRunCtx
      )
    ).toThrow("Missing GitHub bot identity config for agent 'agent-1'");
  });

  it("supports optional fields in typed config shape", () => {
    const parsed = parseGitHubBotIdentityPluginConfig({
      identities: {
        "agent-1": {
          label: "Primary",
          githubUsername: "roshan-bot",
          tokenSecretRef: "secret://github/token",
          allowedOwnerPatterns: ["^roshangautam$"],
          allowedRepos: ["roshangautam/paperclip-github-bot-identity-plugin"],
          commitName: "Roshan Bot",
          commitEmail: "bot@users.noreply.github.com"
        }
      }
    });

    expect(parsed.identities["agent-1"].commitName).toBe("Roshan Bot");
    expect(parsed.identities["agent-1"].commitEmail).toBe("bot@users.noreply.github.com");
  });
});

describe("github repo normalization", () => {
  it("normalizes owner/repo strings and URLs", () => {
    expect(normalizeGitHubRepoRef("RoshanGautam/Paperclip-Github-Bot-Identity-Plugin")?.fullName).toBe(
      "roshangautam/paperclip-github-bot-identity-plugin"
    );
    expect(
      normalizeGitHubRepoRef("https://github.com/roshangautam/paperclip-github-bot-identity-plugin.git")?.fullName
    ).toBe("roshangautam/paperclip-github-bot-identity-plugin");
    expect(
      normalizeGitHubRepoRef("git@github.com:RoshanGautam/Paperclip-Github-Bot-Identity-Plugin.git")?.fullName
    ).toBe("roshangautam/paperclip-github-bot-identity-plugin");
  });
});

describe("github repo policy", () => {
  const identity = {
    label: "Default",
    githubUsername: "roshan-bot",
    tokenSecretRef: "secret://github/token",
    allowedOwnerPatterns: ["^roshangautam$"]
  };

  it("allows roshangautam repos by default", () => {
    expect(evaluateRepoPolicy(identity, "roshangautam/paperclip-github-bot-identity-plugin").allowed).toBe(true);
  });

  it("denies repositories outside roshangautam/* for MVP", () => {
    expect(evaluateRepoPolicy(identity, "paperclipai/paperclip").allowed).toBe(false);
    expect(evaluateRepoPolicy(identity, "affaan-m/everything-claude-code").allowed).toBe(false);
    expect(evaluateRepoPolicy(identity, "openai/plugins").allowed).toBe(false);
    expect(evaluateRepoPolicy(identity, "NousResearch/hermes-agent").allowed).toBe(false);
  });

  it("fails closed when allowedOwnerPatterns is explicitly empty", () => {
    const denyAllIdentity = { ...identity, allowedOwnerPatterns: [] as string[] };
    expect(evaluateRepoPolicy(denyAllIdentity, "roshangautam/paperclip-github-bot-identity-plugin").allowed).toBe(
      false
    );
  });
});
