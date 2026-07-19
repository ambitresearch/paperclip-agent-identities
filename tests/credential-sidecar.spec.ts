import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  CREDENTIAL_SIDECAR_PATH_ENV,
  DEFAULT_CREDENTIAL_SIDECAR_PATH,
  deleteLegacySlackCredentialSidecarEntry,
  parseCredentialSidecar,
  readCredentialSidecar,
  readLegacySlackCredentialSidecarEntry,
  resolveCredentialSidecarPath,
  resolveIdentityToken,
} from "../src/credential-sidecar.js";
import type { ResolvedAgentIdentity } from "../src/providers/github/config.js";

const identity: ResolvedAgentIdentity = {
  agentId: "agent-1",
  identity: { label: "Bot", githubUsername: "bot" },
};

function credentials(entry: unknown) {
  return JSON.stringify({ version: 1, identities: { "agent-1:github": entry } });
}

describe("credential sidecar token resolution", () => {
  const originalPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "credential-sidecar-"));
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  it("validates sidecar credential sources", () => {
    expect(() => parseCredentialSidecar({ version: 1, identities: { "agent-1:github": {} } })).toThrow();
  });

  it("keeps the released v0.1.7/v0.1.8 Slack sidecar shape parseable", () => {
    const parsed = parseCredentialSidecar({
      version: 1,
      identities: {
        "agent-1:slack": {
          slackBotToken: {
            botTokenSecretId: "00000000-0000-4000-8000-000000000007",
          },
        },
      },
    });

    expect(readLegacySlackCredentialSidecarEntry(parsed, "agent-1")).toEqual({
      botTokenSecretId: "00000000-0000-4000-8000-000000000007",
    });
  });

  it("deletes only the exact released Slack entry and preserves sibling credentials", async () => {
    const sidecar = join(directory, "credentials.json");
    const legacy = {
      botTokenSecretId: "00000000-0000-4000-8000-000000000007",
      signingSecretId: "00000000-0000-4000-8000-000000000008",
    };
    await writeFile(sidecar, JSON.stringify({
      version: 1,
      identities: {
        "agent-1:slack": { slackBotToken: legacy },
        "agent-1:github": { secretId: "00000000-0000-4000-8000-000000000009" },
      },
    }));

    await deleteLegacySlackCredentialSidecarEntry("agent-1", legacy, sidecar);

    expect(await readCredentialSidecar(sidecar)).toEqual({
      version: 1,
      identities: {
        "agent-1:github": { secretId: "00000000-0000-4000-8000-000000000009" },
      },
    });
    expect(await readFile(sidecar, "utf8")).not.toContain("slackBotToken");
  });

  it("refuses to delete a released Slack entry that changed after it was read", async () => {
    const sidecar = join(directory, "credentials.json");
    await writeFile(sidecar, JSON.stringify({
      version: 1,
      identities: {
        "agent-1:slack": {
          slackBotToken: {
            botTokenSecretId: "00000000-0000-4000-8000-000000000010",
          },
        },
      },
    }));

    await expect(deleteLegacySlackCredentialSidecarEntry("agent-1", {
      botTokenSecretId: "00000000-0000-4000-8000-000000000011",
    }, sidecar)).rejects.toThrow(/changed before cleanup/);
    expect(readLegacySlackCredentialSidecarEntry(await readCredentialSidecar(sidecar), "agent-1"))
      .toEqual({ botTokenSecretId: "00000000-0000-4000-8000-000000000010" });
  });

  it("defaults the sidecar to the current runtime home directory", async () => {
    delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    const expected = join(homedir(), ".paperclip", "agent-identities", "credentials.json");

    expect(DEFAULT_CREDENTIAL_SIDECAR_PATH).toBe(expected);
    await expect(resolveCredentialSidecarPath()).resolves.toBe(expected);
  });

  it("prefers an explicit sidecar path override", async () => {
    const sidecar = join(directory, "custom-credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecar;

    await expect(resolveCredentialSidecarPath()).resolves.toBe(sidecar);
  });

  it("resolves a relative sidecar override against the worker directory", async () => {
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = "custom-credentials.json";

    await expect(resolveCredentialSidecarPath()).resolves.toBe(resolvePath("custom-credentials.json"));
  });

  it("falls back to a token file when the configured secret cannot resolve", async () => {
    const sidecar = join(directory, "credentials.json");
    const tokenFile = join(directory, "token.txt");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecar;
    await writeFile(tokenFile, "file-token\n");
    await writeFile(sidecar, credentials({
      secretId: "00000000-0000-4000-8000-000000000003", tokenFile,
    }));

    await expect(resolveIdentityToken(identity, async () => { throw new Error("unavailable"); }))
      .resolves.toEqual({ token: "file-token", source: "token-file" });
  });

  it("prefers a successfully resolved plugin secret over a token file", async () => {
    const sidecar = join(directory, "credentials.json");
    const tokenFile = join(directory, "token.txt");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecar;
    await writeFile(tokenFile, "file-token\n");
    await writeFile(sidecar, credentials({
      secretId: "00000000-0000-4000-8000-000000000004", tokenFile,
    }));

    await expect(resolveIdentityToken(identity, async (ref) => "secret:" + ref))
      .resolves.toEqual({
        token: "secret:00000000-0000-4000-8000-000000000004",
        source: "plugin-secret",
      });
  });

  it("mints a GitHub App token from a private-key secret", async () => {
    const sidecar = join(directory, "credentials.json");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecar;
    await writeFile(sidecar, credentials({
      githubApp: {
        appId: "12345", installationId: "67890",
        privateKeySecretId: "00000000-0000-4000-8000-000000000005",
      },
    }));

    const resolved = await resolveIdentityToken(
      identity,
      async () => privateKey,
      async () => new Response(JSON.stringify({ token: "ghs_installation_token" }), { status: 201 }),
    );
    expect(resolved).toEqual({ token: "ghs_installation_token", source: "github-app" });
  });

  it("falls back to a private-key file when private-key secret resolution fails", async () => {
    const sidecar = join(directory, "credentials.json");
    const privateKeyFile = join(directory, "github-app.pem");
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecar;
    await writeFile(privateKeyFile, privateKey);
    await writeFile(sidecar, credentials({
      githubApp: {
        appId: "12345", installationId: "67890",
        privateKeySecretId: "00000000-0000-4000-8000-000000000006",
        privateKeyFile,
      },
    }));

    await expect(resolveIdentityToken(
      identity,
      async () => { throw new Error("unavailable"); },
      async () => new Response(JSON.stringify({ token: "ghs_file_fallback" }), { status: 201 }),
    )).resolves.toEqual({ token: "ghs_file_fallback", source: "github-app" });
  });
});
