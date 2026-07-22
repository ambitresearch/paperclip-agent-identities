import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";

const BOT_TOKEN_SECRET_ID = "00000000-0000-4000-8000-000000000001";
const SIGNING_SECRET_ID = "00000000-0000-4000-8000-000000000002";

function slackConfig() {
  return {
    identities: {
      "agent-slack": {
        label: "GitHub QA",
        githubUsername: "github-qa[bot]",
        slack: {
          label: "Slack QA",
          teamId: "T12345678",
          appId: "A12345678",
          botUserId: "U12345678",
          defaultChannel: "C12345678",
          eventsRequestUrl: "https://paperclip-test.trycloudflare.com/events",
          credentials: {
            botToken: BOT_TOKEN_SECRET_ID,
            signingSecret: SIGNING_SECRET_ID,
          },
        },
      },
    },
  };
}

function containsSecretRef(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(containsSecretRef);
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  return record.format === "secret-ref" || Object.values(record).some(containsSecretRef);
}

function ambiguousSecretRefKeywords(schema: unknown, path = "$"): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((child, index) => ambiguousSecretRefKeywords(child, `${path}[${index}]`));
  }
  if (!schema || typeof schema !== "object") return [];

  const record = schema as Record<string, unknown>;
  const ambiguous = ["oneOf", "anyOf"].flatMap((keyword) => {
    const branches = record[keyword];
    return Array.isArray(branches) && containsSecretRef(branches) ? [`${path}.${keyword}`] : [];
  });

  return [
    ...ambiguous,
    ...Object.entries(record).flatMap(([key, child]) => ambiguousSecretRefKeywords(child, `${path}.${key}`)),
  ];
}

describe("manifest instance config schema", () => {
  const ajv = new Ajv({ allErrors: true });
  addFormatsModule.default(ajv);
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(manifest.instanceConfigSchema!);

  it("uses the Ambit Research plugin namespace", () => {
    expect(manifest.id).toBe("ambitresearch.paperclip-agent-identities");
    expect(manifest.version).toBe("0.2.3");
  });

  it("accepts GitHub and strict Slack config for the same agent", () => {
    expect(validate(slackConfig()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts the flat Slack shape persisted by earlier builds of this PR", () => {
    const config = slackConfig();
    expect(validate({
      identities: { "agent-slack": config.identities["agent-slack"].slack },
    }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts the short-lived Slack metadata discovery binding", () => {
    expect(validate({
      setup: {
        slack: {
          metadata: {
            "0123456789abcdef0123456789abcdef": {
              botToken: BOT_TOKEN_SECRET_ID,
            },
          },
        },
      },
    }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts the empty metadata container left after host binding cleanup", () => {
    expect(validate({
      setup: {
        slack: {
          metadata: {
            "0123456789abcdef0123456789abcdef": {},
          },
        },
      },
    }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("declares secret refs on unambiguous host-visible config paths", () => {
    expect(ambiguousSecretRefKeywords(manifest.instanceConfigSchema)).toEqual([]);
  });

  it("accepts an empty per-agent container after its last provider subtree is deleted", () => {
    expect(validate({ identities: { "agent-deleted": {} } }), JSON.stringify(validate.errors)).toBe(true);
  });

  it("rejects mixed flat GitHub and legacy Slack fields", () => {
    const config = slackConfig();
    const mixed = {
      ...config.identities["agent-slack"].slack,
      githubUsername: "github-qa[bot]",
    };
    expect(validate({ identities: { "agent-slack": mixed } })).toBe(false);
  });

  it.each(["botToken", "signingSecret"] as const)(
    "rejects an unprojected typed ref for Slack %s",
    (credential) => {
      const config = slackConfig();
      config.identities["agent-slack"].slack.credentials[credential] = {
        type: "secret_ref",
        secretId: credential === "botToken" ? BOT_TOKEN_SECRET_ID : SIGNING_SECRET_ID,
        version: "latest",
      } as never;

      expect(validate(config)).toBe(false);
      expect(validate.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({
          instancePath: `/identities/agent-slack/slack/credentials/${credential}`,
          keyword: "type",
        }),
      ]));
    },
  );
});
