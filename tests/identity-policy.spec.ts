import { describe, expect, it } from "vitest";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  evaluateRepoPolicy,
  normalizeGitHubRepoRef,
  parseGitHubBotIdentityPluginConfig,
  resolveAgentIdentityFromToolRunContext
} from "../src/identity-policy.js";
import { parseCredentialSidecar } from "../src/credential-sidecar.js";

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
            githubUsername: "roshan-bot"
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
              githubUsername: "other-bot"
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

describe("github credential sidecar", () => {
  it("parses agent to Paperclip secret UUID mappings", () => {
    const parsed = parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1": { secretId: "00000000-0000-4000-8000-000000000001" }
      }
    });

    expect(parsed.identities["agent-1"].secretId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("rejects non-UUID sidecar secret ids", () => {
    expect(() => parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1": { secretId: "GITHUB_TOKEN" }
      }
    })).toThrow();
  });
});


describe("github repo normalization", () => {
  it("normalizes HTTPS, SSH, .git suffix, and owner/repo input", () => {
    expect(normalizeGitHubRepoRef("https://github.com/RoshanGautam/Genie")?.fullName).toBe("roshangautam/genie");
    expect(normalizeGitHubRepoRef("https://github.com/roshangautam/genie.git")?.fullName).toBe("roshangautam/genie");
    expect(normalizeGitHubRepoRef("git@github.com:RoshanGautam/Genie.git")?.fullName).toBe("roshangautam/genie");
    expect(normalizeGitHubRepoRef("roshangautam/genie")?.fullName).toBe("roshangautam/genie");
  });

  it("normalizes scheme-less and path-suffixed GitHub URLs", () => {
    expect(normalizeGitHubRepoRef("github.com/roshangautam/genie")?.fullName).toBe("roshangautam/genie");
    expect(normalizeGitHubRepoRef("https://github.com/roshangautam/genie/tree/main")?.fullName).toBe(
      "roshangautam/genie"
    );
    expect(
      normalizeGitHubRepoRef("ssh://git@github.com/roshangautam/paperclip-github-bot-identity-plugin.git")?.fullName
    ).toBe("roshangautam/paperclip-github-bot-identity-plugin");
    expect(
      normalizeGitHubRepoRef("git://github.com/roshangautam/paperclip-github-bot-identity-plugin.git")?.fullName
    ).toBe("roshangautam/paperclip-github-bot-identity-plugin");
  });

  it("rejects malformed and non-GitHub URL input", () => {
    expect(normalizeGitHubRepoRef("not-a-repo")).toBeNull();
    expect(normalizeGitHubRepoRef("   ")).toBeNull();
    expect(normalizeGitHubRepoRef("https://gitlab.com/roshangautam/repo.git")).toBeNull();
    expect(normalizeGitHubRepoRef("gitlab.com/roshangautam/repo")).toBeNull();
  });
});

describe("github repo policy", () => {
  const identity = {
    label: "Default",
    githubUsername: "roshan-bot",
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

  it("allows only explicitly approved repositories when allowedRepos is configured", () => {
    const repoScopedIdentity = { ...identity, allowedRepos: ["roshangautam/genie"] };

    expect(evaluateRepoPolicy(repoScopedIdentity, "roshangautam/genie").allowed).toBe(true);
    expect(evaluateRepoPolicy(repoScopedIdentity, "paperclipai/paperclip").allowed).toBe(false);
    expect(evaluateRepoPolicy(repoScopedIdentity, "affaan-m/everything-claude-code").allowed).toBe(false);
    expect(evaluateRepoPolicy(repoScopedIdentity, "openai/plugins").allowed).toBe(false);
    expect(evaluateRepoPolicy(repoScopedIdentity, "NousResearch/hermes-agent").allowed).toBe(false);
  });

  it("fails closed when allowedOwnerPatterns is explicitly empty", () => {
    const denyAllIdentity = { ...identity, allowedOwnerPatterns: [] as string[] };
    expect(evaluateRepoPolicy(denyAllIdentity, "roshangautam/paperclip-github-bot-identity-plugin").allowed).toBe(
      false
    );
  });
});
