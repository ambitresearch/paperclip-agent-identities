import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CREDENTIAL_SIDECAR_PATH_ENV } from "../src/credential-sidecar.js";
import { upsertCredentialSidecarIdentity } from "../src/credential-sidecar.js";
import {
  resolveSlackBotToken,
  resolveSlackSigningSecret,
  assertSlackWorkspaceMatch,
} from "../src/providers/slack/credentials.js";
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

// Stub for the injectable verification step: a fake `auth.test` that reports
// the resolved token really does belong to the expected team, without any
// live network call.
const verifyMatchingWorkspace = async (_token: string) => ({ teamId: "T123" });
const verifyWrongWorkspace = async (_token: string) => ({ teamId: "T999" });

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

  it("resolves the bot token secret and registers it for redaction, without resolving the signing secret", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: {
        botTokenSecretId: "00000000-0000-4000-8000-000000000010",
        signingSecretId: "00000000-0000-4000-8000-000000000011",
      },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    const result = await resolveSlackBotToken(fakeIdentity(), resolveSecret, verifyMatchingWorkspace);

    // Outbound/tool credential resolution only needs the bot token — the
    // signing secret is deferred to inbound Events API verification (see
    // resolveSlackSigningSecret below) and must NOT be resolved here.
    expect(result.token).toBe("resolved:00000000-0000-4000-8000-000000000010");
    expect(result.secrets).toEqual(["resolved:00000000-0000-4000-8000-000000000010"]);
  });

  it("resolves without a signing secret when none is configured", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: {
        botTokenSecretId: "00000000-0000-4000-8000-000000000012",
      },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    const result = await resolveSlackBotToken(fakeIdentity(), resolveSecret, verifyMatchingWorkspace);

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
    await expect(
      resolveSlackBotToken(fakeIdentity("missing-agent"), resolveSecret, verifyMatchingWorkspace)
    ).rejects.toThrow(/Unable to read agent identity credential sidecar/);
  });

  it("fails closed with no operator-identity fallback when the sidecar exists but has no entry for this agent", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000099" },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    await expect(
      resolveSlackBotToken(fakeIdentity("other-agent"), resolveSecret, verifyMatchingWorkspace)
    ).rejects.toThrow(/Missing agent identity credential sidecar entry/);
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
    await expect(
      resolveSlackBotToken(fakeIdentity(), resolveSecret, verifyMatchingWorkspace)
    ).rejects.toThrow();
  });

  it("propagates a revoked/failed secret resolution without silently falling back", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000014" },
    });

    const resolveSecret = async () => {
      throw new Error("secret revoked");
    };

    await expect(
      resolveSlackBotToken(fakeIdentity(), resolveSecret, verifyMatchingWorkspace)
    ).rejects.toThrow(/secret revoked/);
  });

  it("rejects a resolved bot token whose real workspace does not match the configured identity (fail closed, no fallback)", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000016" },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;

    await expect(
      resolveSlackBotToken(fakeIdentity(), resolveSecret, verifyWrongWorkspace)
    ).rejects.toThrow(/workspace mismatch/i);
  });

  it("does not leak the resolved token value in a thrown error message (post-resolution workspace-mismatch failure)", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000015" },
    });

    const fakeResolvedToken = "resolved:fake-bot-token-zzz";
    const resolveSecret = async () => fakeResolvedToken;
    // Simulate a resolved token that actually belongs to a different
    // workspace than the one configured for this agent's identity — this
    // failure happens strictly AFTER `resolveSecret` returns the token, so
    // this test actually exercises the post-resolution code path.
    let thrown: unknown;
    try {
      await resolveSlackBotToken(fakeIdentity(), resolveSecret, verifyWrongWorkspace);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(fakeResolvedToken);
    expect(message).toMatch(/workspace mismatch/i);
  });

  it("does not leak the resolved token value when the verification call itself throws", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000020" },
    });

    const fakeResolvedToken = "resolved:another-fake-token-zzz";
    const resolveSecret = async () => fakeResolvedToken;
    const verifyThrows = async (_token: string): Promise<{ readonly teamId: string }> => {
      throw new Error("network error while verifying");
    };

    let thrown: unknown;
    try {
      await resolveSlackBotToken(fakeIdentity(), resolveSecret, verifyThrows);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain(fakeResolvedToken);
  });
});

describe("resolveSlackSigningSecret", () => {
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

  it("resolves the signing secret separately, for future inbound Events API verification", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: {
        botTokenSecretId: "00000000-0000-4000-8000-000000000017",
        signingSecretId: "00000000-0000-4000-8000-000000000018",
      },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    const signingSecret = await resolveSlackSigningSecret(fakeIdentity(), resolveSecret);

    expect(signingSecret).toBe("resolved:00000000-0000-4000-8000-000000000018");
  });

  it("fails closed when no signing secret is configured (no fallback)", async () => {
    await upsertCredentialSidecarIdentity("agent-1", "slack", {
      slackBotToken: { botTokenSecretId: "00000000-0000-4000-8000-000000000019" },
    });

    const resolveSecret = async (ref: string) => `resolved:${ref}`;
    await expect(resolveSlackSigningSecret(fakeIdentity(), resolveSecret)).rejects.toThrow(
      /signing secret/i
    );
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
