import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CREDENTIAL_SIDECAR_PATH_ENV,
  parseCredentialSidecar,
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
