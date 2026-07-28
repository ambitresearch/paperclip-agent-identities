import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { AGENT_IDENTITIES_PLUGIN_ID } from "../src/shared/webhook-endpoints.js";

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
    // The host mounts this plugin's webhooks under its manifest id, so the id
    // and the route builder must be the same string. If they diverge, derived
    // Slack Events URLs keep pointing at the old id and the ingress guard in
    // src/providers/slack/ingress/provider-webhook.ts rejects every delivery.
    expect(manifest.id).toBe(AGENT_IDENTITIES_PLUGIN_ID);
    expect(manifest.version).toBe("0.2.5");
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

  it.each(["nested", "flat"] as const)(
    "accepts the %s legacy Slack metadata left after credential deletion",
    (shape) => {
      const slack = slackConfig().identities["agent-slack"].slack;
      const { credentials: _credentials, ...metadata } = slack;
      const identity = shape === "nested" ? { slack: metadata } : metadata;
      expect(validate({ identities: { "agent-slack": identity } }), JSON.stringify(validate.errors)).toBe(true);
    },
  );

  it("accepts an empty credential container left after current Slack credential deletion", () => {
    expect(validate({
      identities: { "agent-slack": { slack: { credentials: {} } } },
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

  it.each(["defaultChannel", "eventsRequestUrl"] as const)(
    "rejects a top-level Slack %s on a flat GitHub identity",
    (field) => {
      const config = slackConfig();
      const slack = config.identities["agent-slack"].slack;
      expect(validate({
        identities: {
          "agent-slack": {
            label: "GitHub QA",
            githubUsername: "github-qa[bot]",
            [field]: slack[field],
          },
        },
      })).toBe(false);
    },
  );

  it.each(["defaultChannel", "eventsRequestUrl"] as const)(
    "rejects a stale top-level Slack %s beside the nested Slack identity",
    (field) => {
      const config = slackConfig();
      const identity = config.identities["agent-slack"];
      expect(validate({
        identities: {
          "agent-slack": {
            ...identity,
            [field]: identity.slack[field],
          },
        },
      })).toBe(false);
    },
  );

  it.each(["commitName", "commitEmail"] as const)(
    "rejects GitHub %s on the legacy flat Slack shape",
    (field) => {
      const config = slackConfig();
      expect(validate({
        identities: {
          "agent-slack": {
            ...config.identities["agent-slack"].slack,
            [field]: field === "commitName" ? "GitHub QA" : "github-qa@example.com",
          },
        },
      })).toBe(false);
    },
  );

  // The persisted-config pattern here and normalizeEventsRequestUrl in
  // src/providers/slack/app-manifest.ts gate the same value. A URL one accepts
  // and the other rejects strands an operator with config that saves cleanly
  // and then fails the manifest flow (or, worse, ships a malformed request_url
  // to Slack), so the two lists below mirror the cases in
  // tests/providers/slack/app-manifest.spec.ts.
  it.each([
    "http://paperclip-test.trycloudflare.com/events",
    "https://paperclip-test.trycloudflare.com/events?token=unexpected",
    "https://paperclip-test.trycloudflare.com/events#fragment",
    // Userinfo in the authority: `format: uri` accepts it, so only the
    // pattern's "@"-free authority run rejects it.
    "https://user:pass@paperclip-test.trycloudflare.com/events",
    "https://paperclip-test.trycloudflare.com/sl ack-events",
    // Empty "?"/"#" delimiters, which the manifest flow used to let through.
    "https://paperclip-test.trycloudflare.com/events?",
    "https://paperclip-test.trycloudflare.com/events#",
    // WHATWG normalizes rather than rejects these, so the manifest flow used to
    // accept them: a backslash becomes a slash, illegal characters and
    // malformed escapes are percent-encoded, a non-ASCII host becomes punycode.
    "https://paperclip-test.trycloudflare.com\\events",
    "https://paperclip-test.trycloudflare.com/sl|ack",
    "https://paperclip-test.trycloudflare.com/%zz",
    "https://exámple.com/events",
    // RFC 3986's `port = *DIGIT` is unbounded, so `format: "uri"` used to accept
    // these while the manifest flow's `new URL()` threw.
    "https://paperclip-test.trycloudflare.com:99999/events",
    "https://paperclip-test.trycloudflare.com:notaport/events",
    "not-a-url",
    "https://[fe80::1%25eth0]/events",
    "https://[v1.fe]/events",
    "https://[::::]/events",
    "https://a;.1/events",
  ])(
    "rejects an Events Request URL the manifest flow rejects: %s",
    (eventsRequestUrl) => {
      const config = slackConfig();
      config.identities["agent-slack"].slack.eventsRequestUrl = eventsRequestUrl;
      expect(validate(config)).toBe(false);
    },
  );

  it.each([
    "https://paperclip.example.com/api/companies/company-1/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events",
    "https://paperclip-test.trycloudflare.com/events",
    "https://paperclip-test.trycloudflare.com/events/",
    "https://paperclip-test.trycloudflare.com/not-events",
    // "@" is only barred from the authority; it stays legal in a path.
    "https://paperclip-test.trycloudflare.com/events/a@b",
    "https://paperclip-test.trycloudflare.com:8443/events",
    "https://paperclip-test.trycloudflare.com/a%20b",
    "https://[2001:db8::1]/events",
    "https://[::1]:8443/events",
    "https://192.0.2.10:8443/events",
  ])(
    "accepts an Events Request URL the manifest flow accepts: %s",
    (eventsRequestUrl) => {
      const config = slackConfig();
      config.identities["agent-slack"].slack.eventsRequestUrl = eventsRequestUrl;
      expect(validate(config)).toBe(true);
    },
  );

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
