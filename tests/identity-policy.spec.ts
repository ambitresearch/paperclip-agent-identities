import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  normalizeGitHubRepoRef,
  parseGitHubBotIdentityPluginConfig,
  resolveAgentIdentityFromToolRunContext
} from "../src/identity-policy.js";
import {
  CREDENTIAL_SIDECAR_PATH_ENV,
  parseCredentialSidecar,
  resolveCredentialSidecarPath,
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
  it("resolves configured agent identity without adding repository authorization", () => {
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

    expect(resolved.identity).toEqual({
      label: "Default Bot",
      githubUsername: "roshan-bot"
    });
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
    ).toThrow("Missing agent identity config for agent 'agent-1'");
  });

  it("supports optional fields in typed config shape", () => {
    const parsed = parseGitHubBotIdentityPluginConfig({
      identities: {
        "agent-1": {
          label: "Primary",
          githubUsername: "roshan-bot",
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
        "agent-1:github": { secretId: "00000000-0000-4000-8000-000000000001" }
      }
    });

    expect(parsed.identities["agent-1:github"].secretId).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("parses tokenFile-only fallback mappings", () => {
    const parsed = parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1:github": { tokenFile: "/run/paperclip/github-bot.token" }
      }
    });

    expect(parsed.identities["agent-1:github"].tokenFile).toBe("/run/paperclip/github-bot.token");
  });

  it("rejects entries without secretId or tokenFile", () => {
    expect(() => parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1:github": {}
      }
    })).toThrow();
  });

  it("rejects non-UUID sidecar secret ids", () => {
    expect(() => parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1:github": { secretId: "GITHUB_TOKEN" }
      }
    })).toThrow();
  });
});


describe("github repo normalization", () => {
  it("normalizes HTTPS, SSH, .git suffix, and owner/repo input", () => {
    expect(normalizeGitHubRepoRef("https://github.com/My-Org/Example-Repo")?.fullName).toBe("my-org/example-repo");
    expect(normalizeGitHubRepoRef("https://github.com/my-org/example-repo.git")?.fullName).toBe("my-org/example-repo");
    expect(normalizeGitHubRepoRef("git@github.com:My-Org/Example-Repo.git")?.fullName).toBe("my-org/example-repo");
    expect(normalizeGitHubRepoRef("my-org/example-repo")?.fullName).toBe("my-org/example-repo");
  });

  it("normalizes scheme-less and path-suffixed GitHub URLs", () => {
    expect(normalizeGitHubRepoRef("github.com/my-org/example-repo")?.fullName).toBe("my-org/example-repo");
    expect(normalizeGitHubRepoRef("https://github.com/my-org/example-repo/tree/main")?.fullName).toBe(
      "my-org/example-repo"
    );
    expect(
      normalizeGitHubRepoRef("ssh://git@github.com/my-org/example-repo.git")?.fullName
    ).toBe("my-org/example-repo");
    expect(
      normalizeGitHubRepoRef("git://github.com/my-org/example-repo.git")?.fullName
    ).toBe("my-org/example-repo");
  });

  it("rejects malformed and non-GitHub URL input", () => {
    expect(normalizeGitHubRepoRef("not-a-repo")).toBeNull();
    expect(normalizeGitHubRepoRef("   ")).toBeNull();
    expect(normalizeGitHubRepoRef("https://gitlab.com/my-org/repo.git")).toBeNull();
    expect(normalizeGitHubRepoRef("gitlab.com/my-org/repo")).toBeNull();
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
        tokenSecretRef: "inline-secret-ref-uuid"
      }
    };

    const secretRef = await resolveIdentitySecretRef(resolvedIdentity);
    expect(secretRef).toBe("inline-secret-ref-uuid");
  });


  it("falls back to the legacy default sidecar path when the renamed default is absent", async () => {
    delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    const defaultPath = join(sidecarDir!, "agent-identities", "credentials.json");
    const legacyPath = join(sidecarDir!, "github-bot-identity", "credentials.json");
    await mkdir(join(sidecarDir!, "github-bot-identity"), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ version: 1, identities: {} }), "utf8");

    await expect(resolveCredentialSidecarPath(defaultPath, legacyPath)).resolves.toBe(legacyPath);
  });

  it("falls through to sidecar when tokenSecretRef is undefined", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1:github": { secretId: "00000000-0000-4000-8000-000000000001" }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot"
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
        "agent-other:github": { secretId: "00000000-0000-4000-8000-000000000099" }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-missing",
      identity: {
        label: "Bot",
        githubUsername: "bot"
      }
    };

    await expect(resolveIdentitySecretRef(resolvedIdentity)).rejects.toThrow(
      "Missing agent identity credential sidecar entry for agent 'agent-missing'"
    );
  });

  it("falls through to sidecar when tokenSecretRef is empty/whitespace", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1:github": { secretId: "00000000-0000-4000-8000-000000000002" }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot",
        tokenSecretRef: "   "
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
        "agent-1:github": {
          secretId: "00000000-0000-4000-8000-000000000003",
          tokenFile: tokenPath
        }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot"
      }
    };

    const resolved = await resolveIdentityToken(resolvedIdentity, async () => {
      throw new Error("Secret resolver unavailable");
    });

    expect(resolved).toEqual({ token: "file-token", source: "token-file" });
  });

  it("mints a GitHub App installation token from sidecar app credentials", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    const privateKeyPath = join(sidecarDir!, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(privateKeyPath, privateKey, "utf8");
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1:github": {
          githubApp: {
            appId: "12345",
            installationId: "67890",
            privateKeyFile: privateKeyPath
          }
        }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot"
      }
    };
    const requests: Array<{ url: string; authorization?: string }> = [];

    const resolved = await resolveIdentityToken(
      resolvedIdentity,
      async () => { throw new Error("secret resolver should not be used"); },
      async (url, init) => {
        requests.push({ url, authorization: init?.headers ? new Headers(init.headers).get("authorization") ?? undefined : undefined });
        return new Response(JSON.stringify({ token: "ghs_installation_token" }), { status: 201 });
      }
    );

    expect(resolved).toEqual({ token: "ghs_installation_token", source: "github-app" });
    expect(requests[0]?.url).toBe("https://api.github.com/app/installations/67890/access_tokens");
    expect(requests[0]?.authorization).toMatch(/^Bearer .+\..+\..+$/);
  });

  it("prefers plugin secret resolution when secretId succeeds even if tokenFile is present", async () => {
    const sidecarPath = join(sidecarDir!, "credentials.json");
    const tokenPath = join(sidecarDir!, "token.txt");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(tokenPath, "file-token\n", "utf8");
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1:github": {
          secretId: "00000000-0000-4000-8000-000000000004",
          tokenFile: tokenPath
        }
      }
    }), "utf8");

    const resolvedIdentity = {
      agentId: "agent-1",
      identity: {
        label: "Bot",
        githubUsername: "bot"
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
        tokenSecretRef: "inline-secret-ref"
      }
    };

    const resolved = await resolveIdentityToken(resolvedIdentity, async (secretRef) => `secret:${secretRef}`);

    expect(resolved).toEqual({ token: "secret:inline-secret-ref", source: "plugin-secret" });
  });

});
