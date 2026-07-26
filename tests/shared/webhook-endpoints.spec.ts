import { describe, expect, it } from "vitest";
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
    expect(url).toMatch(/^https:\/\/[^\s?#]+$/);
  });
});
