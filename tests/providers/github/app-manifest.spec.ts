import { describe, it, expect } from "vitest";
import {
  createGitHubAppManifestFlow,
  normalizeGitHubAppManifestFlowState,
} from "../../../src/providers/github/app-manifest.js";

describe("createGitHubAppManifestFlow", () => {
  it("builds a manifest + install state for a github identity", () => {
    const result = createGitHubAppManifestFlow({
      agentId: "agent-1",
      label: "Release Bot",
      callbackUrl: "https://paperclip.roshangautam.com",
    } as never);

    expect(result.agentId).toBe("agent-1");
    expect(result.provider).toBe("github");
    expect(result.state).toMatch(/^pc_[0-9a-f]{32}$/);
    expect(result.postUrl).toContain("github.com/settings/apps/new?state=");
    const manifest = JSON.parse(result.manifest);
    expect(manifest.default_permissions.contents).toBe("write");
  });

  it("rejects an agentId that is not a single path segment", () => {
    expect(() =>
      createGitHubAppManifestFlow({ agentId: "../escape", label: "x" } as never),
    ).toThrow(/single path segment/);
  });

  it("rejects a non-github provider", () => {
    expect(() =>
      createGitHubAppManifestFlow({ agentId: "a", label: "x", provider: "example" } as never),
    ).toThrow(/GitHub/);
  });
});

describe("normalizeGitHubAppManifestFlowState", () => {
  it("returns null for a non-record", () => {
    expect(normalizeGitHubAppManifestFlowState(null)).toBeNull();
    expect(normalizeGitHubAppManifestFlowState("nope")).toBeNull();
  });

  it("round-trips a freshly created flow", () => {
    const created = createGitHubAppManifestFlow({
      agentId: "agent-1",
      label: "Release Bot",
      callbackUrl: "https://paperclip.roshangautam.com",
    } as never);
    const normalized = normalizeGitHubAppManifestFlowState(created);
    expect(normalized?.state).toBe(created.state);
    expect(normalized?.provider).toBe("github");
  });
});
