import { describe, it, expect } from "vitest";
import {
  createSlackAppManifestFlow,
  normalizeSlackAppManifestFlowState,
} from "../../../src/providers/slack/app-manifest.js";

const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";

describe("createSlackAppManifestFlow", () => {
  it("builds an MVP manifest + setup state for a slack identity", () => {
    const result = createSlackAppManifestFlow(
      { agentId: "agent-1", label: "Release Bot" } as never,
      COMPANY_ID,
    );

    expect(result.agentId).toBe("agent-1");
    expect(result.provider).toBe("slack");
    expect(result.companyId).toBe(COMPANY_ID);
    expect(result.state).toMatch(/^pc_[0-9a-f]{32}$/);
    expect(result.createAppUrl).toBe("https://api.slack.com/apps?new_app=1");
    expect(result.createAppUrl).not.toContain("manifest_json");
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(new Date(result.createdAt).getTime());

    const manifest = JSON.parse(result.manifest);
    expect(manifest.oauth_config.scopes.bot).toEqual(["chat:write", "channels:read", "groups:read", "reactions:write"]);
    expect(manifest.oauth_config.scopes.bot).not.toContain("app_mentions:read");
    expect(manifest.settings.event_subscriptions).toBeUndefined();
    expect(manifest.settings.interactivity.is_enabled).toBe(false);
    expect(manifest.settings.socket_mode_enabled).toBe(false);
    expect(manifest.settings.token_rotation_enabled).toBe(false);
    expect(manifest.oauth_config.redirect_urls).toBeUndefined();
  });

  it("rejects an agentId that is not a single path segment", () => {
    expect(() =>
      createSlackAppManifestFlow({ agentId: "../escape", label: "x" } as never, COMPANY_ID),
    ).toThrow(/single path segment/);
  });

  it("rejects a non-slack provider", () => {
    expect(() =>
      createSlackAppManifestFlow({ agentId: "a", label: "x", provider: "example" } as never, COMPANY_ID),
    ).toThrow(/Slack/);
  });
});

describe("normalizeSlackAppManifestFlowState", () => {
  it("returns null for a non-record", () => {
    expect(normalizeSlackAppManifestFlowState(null)).toBeNull();
    expect(normalizeSlackAppManifestFlowState("nope")).toBeNull();
  });

  it("round-trips a freshly created flow", () => {
    const created = createSlackAppManifestFlow({ agentId: "agent-1", label: "Release Bot" } as never, COMPANY_ID);
    const normalized = normalizeSlackAppManifestFlowState(created);
    expect(normalized?.state).toBe(created.state);
    expect(normalized?.provider).toBe("slack");
    expect(normalized?.companyId).toBe(COMPANY_ID);
  });

  it("returns null when required fields are missing", () => {
    const created = createSlackAppManifestFlow({ agentId: "agent-1", label: "Release Bot" } as never, COMPANY_ID);
    const { state: _state, ...withoutState } = created;
    expect(normalizeSlackAppManifestFlowState(withoutState)).toBeNull();
  });
});
