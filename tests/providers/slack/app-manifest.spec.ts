import { describe, it, expect } from "vitest";
import {
  createSlackAppManifestFlow,
  normalizeSlackAppManifestFlowState,
} from "../../../src/providers/slack/app-manifest.js";

const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";
const EVENTS_REQUEST_URL = "https://paperclip-test.trycloudflare.com/events";

describe("createSlackAppManifestFlow", () => {
  it("builds an MVP manifest + setup state for a slack identity", () => {
    const result = createSlackAppManifestFlow(
      { agentId: "agent-1", label: "Release Bot", eventsRequestUrl: EVENTS_REQUEST_URL } as never,
      COMPANY_ID,
    );

    expect(result.agentId).toBe("agent-1");
    expect(result.provider).toBe("slack");
    expect(result.companyId).toBe(COMPANY_ID);
    expect(result.state).toMatch(/^pc_[0-9a-f]{32}$/);
    expect(result.createAppUrl).toBe("https://api.slack.com/apps?new_app=1");
    expect(result.eventsRequestUrl).toBe(EVENTS_REQUEST_URL);
    expect(result.createAppUrl).not.toContain("manifest_json");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(new Date(result.createdAt).getTime());

    const manifest = JSON.parse(result.manifest);
    expect(result.manifest).toBe(JSON.stringify(manifest, null, 2));
    expect(result.manifest).toContain('\n  "display_information": {');
    expect(manifest.features.bot_user).toEqual({
      display_name: "Paperclip Agent - Release Bot",
      always_online: false,
    });
    expect(manifest.features.app_home).toEqual({
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.features.agent_view).toEqual({
      agent_description: "Paperclip agent identity for Release Bot",
    });
    expect(manifest.features.assistant_view).toBeUndefined();
    expect(manifest.oauth_config.scopes.bot).toEqual([
      "assistant:write",
      "app_mentions:read",
      "chat:write",
      "channels:read",
      "groups:read",
      "im:history",
      "reactions:write",
      "users:read",
    ]);
    expect(manifest.settings.event_subscriptions).toEqual({
      request_url: EVENTS_REQUEST_URL,
      bot_events: ["app_home_opened", "app_mention", "message.im"],
    });
    expect(manifest.settings.interactivity.is_enabled).toBe(false);
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.settings.token_rotation_enabled).toBe(false);
    expect(manifest.oauth_config.redirect_urls).toBeUndefined();
  });

  it("rejects an agentId that is not a single path segment", () => {
    expect(() =>
      createSlackAppManifestFlow(
        { agentId: "../escape", label: "x", eventsRequestUrl: EVENTS_REQUEST_URL } as never,
        COMPANY_ID,
      ),
    ).toThrow(/single path segment/);
  });

  it("rejects a non-slack provider", () => {
    expect(() =>
      createSlackAppManifestFlow(
        { agentId: "a", label: "x", provider: "example", eventsRequestUrl: EVENTS_REQUEST_URL } as never,
        COMPANY_ID,
      ),
    ).toThrow(/Slack/);
  });

  it.each([
    "http://paperclip-test.trycloudflare.com/events",
    "https://paperclip-test.trycloudflare.com/events/",
    "https://paperclip-test.trycloudflare.com/not-events",
    "https://paperclip-test.trycloudflare.com/events?token=unexpected",
  ])("rejects an invalid Events Request URL: %s", (eventsRequestUrl) => {
    expect(() =>
      createSlackAppManifestFlow({ agentId: "a", label: "x", eventsRequestUrl }, COMPANY_ID),
    ).toThrow(/eventsRequestUrl/);
  });
});

describe("normalizeSlackAppManifestFlowState", () => {
  it("returns null for a non-record", () => {
    expect(normalizeSlackAppManifestFlowState(null)).toBeNull();
    expect(normalizeSlackAppManifestFlowState("nope")).toBeNull();
  });

  it("round-trips a freshly created flow", () => {
    const created = createSlackAppManifestFlow(
      { agentId: "agent-1", label: "Release Bot", eventsRequestUrl: EVENTS_REQUEST_URL } as never,
      COMPANY_ID,
    );
    const normalized = normalizeSlackAppManifestFlowState(created);
    expect(normalized?.state).toBe(created.state);
    expect(normalized?.provider).toBe("slack");
    expect(normalized?.companyId).toBe(COMPANY_ID);
  });

  it("returns null when required fields are missing", () => {
    const created = createSlackAppManifestFlow(
      { agentId: "agent-1", label: "Release Bot", eventsRequestUrl: EVENTS_REQUEST_URL } as never,
      COMPANY_ID,
    );
    const { state: _state, ...withoutState } = created;
    expect(normalizeSlackAppManifestFlowState(withoutState)).toBeNull();
  });
});
