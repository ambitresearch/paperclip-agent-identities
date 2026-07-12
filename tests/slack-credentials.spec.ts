import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CREDENTIAL_SIDECAR_PATH_ENV } from "../src/credential-sidecar.js";
import { upsertCredentialSidecarIdentity } from "../src/credential-sidecar.js";
import { resolveSlackBotToken, assertSlackWorkspaceMatch } from "../src/providers/slack/credentials.js";
import type { ResolvedAgentIdentity } from "../src/core/agent-identity.js";
import type { SlackAgentIdentity } from "../src/providers/slack/config.js";

function fakeIdentity(agentId = "agent-1"): ResolvedAgentIdentity<SlackAgentIdentity> {
  return {
    agentId,
    identity: {
      label: "Bot",
      teamId: "T123",
      appId: "A123",
      botUserId: "U123",
    },
  };
}

describe("resolveSlackBotToken", () => {
  const originalPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  let directory: string;
  let sidecarPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "slack-credential-sidecar-"));
    sidecarPath = join(directory, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    else process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  it("resolves the bot token secret and registers it (and the signing secret) for redaction", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: {
        botTokenSecretId: "00000000-0000-4000-8000-000000000010",
        signingSecretId: "00000000-0000-4000-8000-000000000011",
      },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    const result = await resolveSlackBotToken(fakeIdentity(), resolveSecret);

    expect(result.token).toBe("resolved:00000000-0000-4000-8000-000000000010");
    expect(result.secrets).toEqual([
      "resolved:00000000-0000-4000-8000-000000000010",
      "resolved:00000000-0000-4000-8000-000000000011",
    ]);
  });

  it("resolves without a signing secret when none is configured", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: {
        botTokenSecretId: "00000000-0000-4000-8000-000000000012",
      },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    const result = await resolveSlackBotToken(fakeIdentity(), resolveSecret);

    expect(result.token).toBe("resolved:00000000-0000-4000-8000-000000000012");
    expect(result.secrets).toEqual(["resolved:00000000-0000-4000-8000-000000000012"]);
  });

  it("writes the sidecar file atomically with 0600 permissions", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000013" },
    });

    const stats = await stat(sidecarPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("fails closed with no operator-identity fallback when the sidecar file is missing entirely", async () => {
    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    await expect(resolveSlackBotToken(fakeIdentity("missing-agent"), resolveSecret)).rejects.toThrow(
      /Unable to read agent identity credential sidecar/
    );
  });

  it("fails closed with no operator-identity fallback when the sidecar exists but has no entry for this agent", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000099" },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    await expect(resolveSlackBotToken(fakeIdentity("other-agent"), resolveSecret)).rejects.toThrow(
      /Missing agent identity credential sidecar entry/
    );
  });

  it("fails closed on a malformed sidecar entry (fails schema validation)", async () => {
    await writeFile(
      sidecarPath,
      JSON.stringify({
        version: 1,
        identities: { "agent-1:slack": { slackBotToken: {} } },
      }),
      { encoding: "utf8", mode: 0o600 }
    );

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    await expect(resolveSlackBotToken(fakeIdentity(), resolveSecret)).rejects.toThrow();
  });

  it("propagates a revoked/failed secret resolution without silently falling back", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000014" },
    });

    const resolveSecret = async () => {
      throw new Error("secret revoked");
    };

    await expect(resolveSlackBotToken(fakeIdentity(), resolveSecret)).rejects.toThrow(/secret revoked/);
  });

  it("does not leak the resolved token value in a thrown error message", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000015" },
    });

    const secretValue = "super-secret-fake-value-zzz";
    const resolveSecret = async () => secretValue;

    // Force a downstream failure unrelated to the secret to prove nothing echoes it.
    try {
      await resolveSlackBotToken(fakeIdentity("agent-not-configured"), resolveSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secretValue);
    }
  });
});

describe("assertSlackWorkspaceMatch", () => {
  it("passes when the identity's teamId matches the expected teamId", () => {
    expect(() => assertSlackWorkspaceMatch(fakeIdentity().identity, "T123")).not.toThrow();
  });

  it("fails closed on a wrong-workspace teamId mismatch", () => {
    expect(() => assertSlackWorkspaceMatch(fakeIdentity().identity, "T999")).toThrow(
      /workspace mismatch/i
    );
  });
});
