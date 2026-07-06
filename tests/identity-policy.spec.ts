import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  evaluateRepoPolicy,
  normalizeGitHubRepoRef,
  parseGitHubBotIdentityPluginConfig,
  resolveAgentIdentityFromToolRunContext
} from "../src/identity-policy.js";
import {
  CREDENTIAL_SIDECAR_PATH_ENV,
  parseCredentialSidecar,
  resolveIdentitySecretRef,
  resolveIdentityToken
} from "../src/credential-sidecar.js";

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

  it("parses tokenFile-only fallback mappings", () => {
    const parsed = parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1": { tokenFile: "/run/paperclip/github-bot.token" }
      }
    });

    expect(parsed.identities["agent-1"].tokenFile).toBe("/run/paperclip/github-bot.token");
  });

  it("rejects entries without secretId or tokenFile", () => {
    expect(() => parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1": {}
      }
    })).toThrow();
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

describe("resolveIdentitySecretRef", () => {
  const originalCredentialSidecarPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  let sidecarDir: string | null = null;

  beforeEach(async () => {
    sidecarDir = await mkdtemp(join(tmpdir(), "identity-secret-ref-test-"));
  });

  afterEach(async () => {
    if (originalCredentialSidecarPath === undefined) {
      delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    } else {
      process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalCredentialSidecarPath;
    }
    if (sidecarDir) {
      await rm(sidecarDir, { recursive: true, force: true });
      sidecarDir = null;
    }
  });

  it("returns inline tokenSecretRef when present, without reading sidecar", async () => {
    // Point sidecar at a non-existent path — if it tries to read, it will throw
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = join(sidecarDir!, "does-not-exist.json");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        tokenSecretRef: "inline-secret-ref-uuid",
        allowedOwnerPatterns: ["^roshangautam$"]
      }
    };

    const secretRef = await resolveIdentitySecretRef(resolvedIdentity);
    expect(secretRef).toBe("inline-secret-ref-uuid");
  });

  it("falls through to sidecar when tokenSecretRef is undefined", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1": { secretId: "00000000-0000-4000-8000-000000000001" }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        allowedOwnerPatterns: ["^roshangautam$"]
      }
    };

    const secretRef = await resolveIdentitySecretRef(resolvedIdentity);
    expect(secretRef).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("throws when agent has no sidecar entry and no inline tokenSecretRef", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-other": { secretId: "00000000-0000-4000-8000-000000000099" }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-missing",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        allowedOwnerPatterns: ["^roshangautam$"]
      }
    };

    await expect(resolveIdentitySecretRef(resolvedIdentity)).rejects.toThrow(
      "Missing GitHub bot credential sidecar entry for agent 'agent-missing'"
    );
  });

  it("falls through to sidecar when tokenSecretRef is empty/whitespace", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1": { secretId: "00000000-0000-4000-8000-000000000002" }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        tokenSecretRef: "   ",
        allowedOwnerPatterns: ["^roshangautam$"]
      }
    };

    const secretRef = await resolveIdentitySecretRef(resolvedIdentity);
    expect(secretRef).toBe("00000000-0000-4000-8000-000000000002");
  });

  it("resolves token via sidecar tokenFile when plugin secret resolution is unavailable", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    const tokenPath = join(sidecarDir!, "token.txt");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(tokenPath, "file-token\n", "utf8");
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1": {
          secretId: "00000000-0000-4000-8000-000000000003",
          tokenFile: tokenPath
        }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        allowedOwnerPatterns: ["^roshangautam$"]
      }
    };

    const resolved = await resolveIdentityToken(resolvedIdentity, async () => {
      throw new Error("Plugin secret references are disabled until company-scoped plugin config lands");
    });

    expect(resolved).toEqual({ token: "file-token", source: "token-file" });
  });

  it("prefers plugin secret resolution when secretId succeeds even if tokenFile is present", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    const tokenPath = join(sidecarDir!, "token.txt");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(tokenPath, "file-token\n", "utf8");
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1": {
          secretId: "00000000-0000-4000-8000-000000000004",
          tokenFile: tokenPath
        }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        allowedOwnerPatterns: ["^roshangautam$"]
      }
    };

    const resolved = await resolveIdentityToken(resolvedIdentity, async (secretRef) => `secret:${secretRef}`);

    expect(resolved).toEqual({
      token: "secret:00000000-0000-4000-8000-000000000004",
      source: "plugin-secret"
    });
  });

  it("returns inline tokenSecretRef through plugin secret resolution without reading sidecar tokenFile", async () => {
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = join(sidecarDir!, "does-not-exist.json");
    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        tokenSecretRef: "inline-secret-ref",
        allowedOwnerPatterns: ["^roshangautam$"]
      }
    };

    const resolved = await resolveIdentityToken(resolvedIdentity, async (secretRef) => `secret:${secretRef}`);

    expect(resolved).toEqual({ token: "secret:inline-secret-ref", source: "plugin-secret" });
  });

});
