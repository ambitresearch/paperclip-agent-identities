import { describe, expect, it, vi } from "vitest";
import {
  discoverSlackAppId,
  resolveSlackBotToken,
  resolveSlackSigningSecret,
  assertSlackWorkspaceMatch,
} from "../src/providers/slack/credentials.js";
import type { ResolvedAgentIdentity } from "../src/core/agent-identity.js";
import type { SlackAgentIdentity, SlackSecretRef } from "../src/providers/slack/config.js";

const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";
const BOT_TOKEN_REF = {
  type: "secret_ref",
  secretId: "00000000-0000-4000-8000-000000000010",
  version: "latest",
} as const satisfies SlackSecretRef;
const SIGNING_SECRET_REF = {
  type: "secret_ref",
  secretId: "00000000-0000-4000-8000-000000000011",
  version: "latest",
} as const satisfies SlackSecretRef;

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

function slackConfig(agentId = "agent-1"): Record<string, unknown> {
  return {
    identities: {
      [agentId]: {
        slack: {
          label: "Bot",
          teamId: "T123",
          appId: "A123",
          botUserId: "U123",
          credentials: {
            botToken: BOT_TOKEN_REF,
            signingSecret: SIGNING_SECRET_REF,
          },
        },
      },
    },
  };
}

describe("discoverSlackAppId", () => {
  it("explains how to recover when the installed token is missing users:read", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: "missing_scope" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(discoverSlackAppId("xoxb-test", "B123", fetchImpl as never)).rejects.toThrow(
      /latest generated manifest.*reinstall.*users:read/i,
    );
  });
});

const verifyMatchingWorkspace = async (_token: string) => ({ teamId: "T123", userId: "U123", botId: "B123" });
const verifyWrongWorkspace = async (_token: string) => ({ teamId: "T999", userId: "U123", botId: "B123" });
const verifyUserTokenNoBotId = async (_token: string) => ({ teamId: "T123", userId: "U123", botId: undefined });
const verifyWrongBotUser = async (_token: string) => ({ teamId: "T123", userId: "U999", botId: "B999" });

describe("resolveSlackBotToken", () => {
  it("resolves only the exact company-scoped bot-token object ref and registers the token for redaction", async () => {
    const resolveSecret = vi.fn(async (ref: SlackSecretRef) => `resolved:${ref.secretId}`);

    const result = await resolveSlackBotToken(
      fakeIdentity(),
      slackConfig(),
      COMPANY_ID,
      resolveSecret,
      verifyMatchingWorkspace,
    );

    expect(resolveSecret).toHaveBeenCalledOnce();
    expect(resolveSecret).toHaveBeenCalledWith(BOT_TOKEN_REF, {
      companyId: COMPANY_ID,
      configPath: "identities.agent-1.slack.credentials.botToken",
    });
    expect(result).toEqual({
      token: `resolved:${BOT_TOKEN_REF.secretId}`,
      secrets: [`resolved:${BOT_TOKEN_REF.secretId}`],
    });
  });

  it("fails closed before secret resolution without a host-authorized company", async () => {
    const resolveSecret = vi.fn(async () => "unused");

    await expect(
      resolveSlackBotToken(fakeIdentity(), slackConfig(), "", resolveSecret, verifyMatchingWorkspace),
    ).rejects.toThrow(/host-authorized companyId/);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("fails closed when the company-scoped config has no matching identity", async () => {
    const resolveSecret = vi.fn(async () => "unused");

    await expect(
      resolveSlackBotToken(fakeIdentity("other-agent"), slackConfig(), COMPANY_ID, resolveSecret, verifyMatchingWorkspace),
    ).rejects.toThrow(/botToken secret reference/);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects a bare UUID instead of resolving it outside a bound config path", async () => {
    const config = slackConfig();
    const identity = ((config.identities as Record<string, Record<string, unknown>>)["agent-1"]
      .slack as Record<string, unknown>);
    identity.credentials = {
      botToken: BOT_TOKEN_REF.secretId,
      signingSecret: SIGNING_SECRET_REF,
    };
    const resolveSecret = vi.fn(async () => "unused");

    await expect(
      resolveSlackBotToken(fakeIdentity(), config, COMPANY_ID, resolveSecret, verifyMatchingWorkspace),
    ).rejects.toThrow(/botToken secret reference/);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("propagates a revoked secret resolution without a fallback", async () => {
    const resolveSecret = vi.fn(async () => {
      throw new Error("secret revoked");
    });

    await expect(
      resolveSlackBotToken(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, verifyMatchingWorkspace),
    ).rejects.toThrow(/secret revoked/);
  });

  it("continues resolving the flat Slack config persisted by earlier builds of this PR", async () => {
    const config = slackConfig();
    const nested = (config.identities as Record<string, Record<string, unknown>>)["agent-1"]
      .slack as Record<string, unknown>;
    (config.identities as Record<string, unknown>)["agent-1"] = nested;
    const resolveSecret = vi.fn(async () => "resolved-token");

    await resolveSlackBotToken(
      fakeIdentity(),
      config,
      COMPANY_ID,
      resolveSecret,
      verifyMatchingWorkspace,
    );

    expect(resolveSecret).toHaveBeenCalledWith(BOT_TOKEN_REF, {
      companyId: COMPANY_ID,
      configPath: "identities.agent-1.credentials.botToken",
    });
  });

  it("rejects a token for the wrong workspace without leaking the resolved token", async () => {
    const token = "resolved:fake-bot-token-zzz";
    const resolveSecret = vi.fn(async () => token);

    let thrown: unknown;
    try {
      await resolveSlackBotToken(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, verifyWrongWorkspace);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).toMatch(/workspace mismatch/i);
    expect(message).not.toContain(token);
  });

  it("rejects a same-workspace human OAuth token with no bot_id", async () => {
    const resolveSecret = vi.fn(async () => "resolved-token");

    await expect(
      resolveSlackBotToken(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, verifyUserTokenNoBotId),
    ).rejects.toThrow(/bot_id/);
  });

  it("rejects another bot whose user_id does not match botUserId", async () => {
    const resolveSecret = vi.fn(async () => "resolved-token");

    await expect(
      resolveSlackBotToken(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, verifyWrongBotUser),
    ).rejects.toThrow(/botUserId/);
  });

  it("does not leak the resolved token when auth verification throws", async () => {
    const token = "resolved:another-fake-token-zzz";
    const resolveSecret = vi.fn(async () => token);
    const verifyThrows = async () => {
      throw new Error("network error while verifying");
    };

    let thrown: unknown;
    try {
      await resolveSlackBotToken(fakeIdentity(), slackConfig(), COMPANY_ID, resolveSecret, verifyThrows);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.message : String(thrown)).not.toContain(token);
  });
});

describe("resolveSlackSigningSecret", () => {
  it("resolves the distinct signing-secret object ref at its exact company-scoped path", async () => {
    const resolveSecret = vi.fn(async (ref: SlackSecretRef) => `resolved:${ref.secretId}`);

    const signingSecret = await resolveSlackSigningSecret(
      fakeIdentity(),
      slackConfig(),
      COMPANY_ID,
      resolveSecret,
    );

    expect(signingSecret).toBe(`resolved:${SIGNING_SECRET_REF.secretId}`);
    expect(resolveSecret).toHaveBeenCalledWith(SIGNING_SECRET_REF, {
      companyId: COMPANY_ID,
      configPath: "identities.agent-1.slack.credentials.signingSecret",
    });
  });

  it("fails closed when the signing-secret binding is absent", async () => {
    const config = slackConfig();
    const identity = ((config.identities as Record<string, Record<string, unknown>>)["agent-1"]
      .slack as Record<string, unknown>);
    identity.credentials = { botToken: BOT_TOKEN_REF };
    const resolveSecret = vi.fn(async () => "unused");

    await expect(
      resolveSlackSigningSecret(fakeIdentity(), config, COMPANY_ID, resolveSecret),
    ).rejects.toThrow(/signingSecret secret reference/);
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("rejects a bare UUID instead of resolving it outside a bound config path", async () => {
    const config = slackConfig();
    const identity = ((config.identities as Record<string, Record<string, unknown>>)["agent-1"]
      .slack as Record<string, unknown>);
    identity.credentials = {
      botToken: BOT_TOKEN_REF,
      signingSecret: SIGNING_SECRET_REF.secretId,
    };
    const resolveSecret = vi.fn(async () => "unused");

    await expect(
      resolveSlackSigningSecret(fakeIdentity(), config, COMPANY_ID, resolveSecret),
    ).rejects.toThrow(/signingSecret secret reference/);
    expect(resolveSecret).not.toHaveBeenCalled();
  });
});

describe("assertSlackWorkspaceMatch", () => {
  it("passes when the identity team matches", () => {
    expect(() => assertSlackWorkspaceMatch(fakeIdentity().identity, "T123")).not.toThrow();
  });

  it("fails closed on a workspace mismatch", () => {
    expect(() => assertSlackWorkspaceMatch(fakeIdentity().identity, "T999")).toThrow(/workspace mismatch/i);
  });
});
