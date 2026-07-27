import { describe, expect, it } from "vitest";
import { matchesEventsRequestUrlEnvelope } from "../../src/shared/events-request-url.js";
import {
  AGENT_IDENTITIES_PLUGIN_ID,
  SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY,
  buildSlackEventsRequestUrl,
  pluginWebhookPath,
  slackEventsWebhookPath,
} from "../../src/shared/webhook-endpoints.js";

describe("pluginWebhookPath", () => {
  it("builds the host's company-scoped webhook route", () => {
    expect(pluginWebhookPath("company-1", "slack-events")).toBe(
      `/api/companies/company-1/plugins/${AGENT_IDENTITIES_PLUGIN_ID}/webhooks/slack-events`,
    );
  });

  it("encodes the company id", () => {
    expect(pluginWebhookPath("company/one", "slack-events")).toContain("/api/companies/company%2Fone/plugins/");
  });

  it("leaves the plugin id unencoded so it matches the dev adapter's upstream path", () => {
    expect(pluginWebhookPath("company-1", "slack-events")).toContain(
      "/plugins/ambitresearch.paperclip-agent-identities/webhooks/",
    );
  });
});

describe("slackEventsWebhookPath", () => {
  it("uses the endpoint key the Slack provider declares", () => {
    expect(slackEventsWebhookPath("company-1")).toBe(
      pluginWebhookPath("company-1", SLACK_EVENTS_WEBHOOK_ENDPOINT_KEY),
    );
    expect(slackEventsWebhookPath("company-1").endsWith("/webhooks/slack-events")).toBe(true);
  });
});

describe("buildSlackEventsRequestUrl", () => {
  it("derives the deployment's own Slack Events URL from an HTTPS origin", () => {
    expect(buildSlackEventsRequestUrl("https://paperclip.example.com", "company-1")).toBe(
      `https://paperclip.example.com/api/companies/company-1/plugins/${AGENT_IDENTITIES_PLUGIN_ID}/webhooks/slack-events`,
    );
  });

  it("preserves a non-default port", () => {
    expect(buildSlackEventsRequestUrl("https://paperclip.example.com:8443", "company-1")).toContain(
      "https://paperclip.example.com:8443/api/companies/",
    );
  });

  it("ignores anything past the origin", () => {
    expect(buildSlackEventsRequestUrl("https://paperclip.example.com/settings?tab=slack", "company-1")).toBe(
      buildSlackEventsRequestUrl("https://paperclip.example.com", "company-1"),
    );
  });

  it("returns null for a non-HTTPS origin so local dev still requires a tunnel URL", () => {
    expect(buildSlackEventsRequestUrl("http://localhost:3100", "company-1")).toBeNull();
  });

  it("returns null when the company id is missing", () => {
    expect(buildSlackEventsRequestUrl("https://paperclip.example.com", "")).toBeNull();
    expect(buildSlackEventsRequestUrl("https://paperclip.example.com", "   ")).toBeNull();
  });

  it("returns null for an unparseable origin", () => {
    expect(buildSlackEventsRequestUrl("", "company-1")).toBeNull();
    expect(buildSlackEventsRequestUrl("not-a-url", "company-1")).toBeNull();
  });

  it("trims the company id", () => {
    expect(buildSlackEventsRequestUrl("https://paperclip.example.com", "  company-1  ")).toBe(
      buildSlackEventsRequestUrl("https://paperclip.example.com", "company-1"),
    );
  });

  it("produces a URL the app-manifest validator and config schema both accept", () => {
    const url = buildSlackEventsRequestUrl("https://paperclip.roshangautam.com", "company-1");
    expect(url).not.toBeNull();
    expect(matchesEventsRequestUrlEnvelope(url as string)).toBe(true);
  });

  // `URL.origin` keeps the brackets and colons for an IP-literal, none of which
  // are legal in a `reg-name`. The Settings UI only checks that the derived URL
  // is non-empty before enabling manifest creation, so a URL that failed the
  // envelope here would enable a button whose request the worker then rejects.
  it.each([
    ["https://[2001:db8::1]", "https://[2001:db8::1]"],
    ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
    ["https://[::1]", "https://[::1]"],
    ["https://[2001:0db8:0000:0000:0000:0000:0000:0001]", "https://[2001:db8::1]"],
  ])("derives an envelope-conforming URL for %s", (origin, expectedOrigin) => {
    const url = buildSlackEventsRequestUrl(origin, "company-1");
    expect(url).toBe(`${expectedOrigin}${slackEventsWebhookPath("company-1")}`);
    expect(matchesEventsRequestUrlEnvelope(url as string)).toBe(true);
  });

  // The derivation is bound to the same single source of truth as both gates, so
  // it can never hand the UI a value the worker would refuse.
  it("returns null when the derived URL would fail the shared envelope", () => {
    const url = buildSlackEventsRequestUrl("https://a;.1", "company-1");
    expect(url).toBeNull();
  });
});
