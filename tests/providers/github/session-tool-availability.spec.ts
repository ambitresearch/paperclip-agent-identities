import { describe, it, expect } from "vitest";
import { githubManifestTools } from "../../../src/providers/github/manifest-tools.js";
import { simulateSessionToolDiscovery } from "../../helpers/session-tool-discovery.js";

/**
 * DRO-1163 / paperclipai/paperclip#10346
 *
 * Incident recap: a live `codex_local` run had this plugin's GitHub tools
 * registered globally (asserted below), and per-run tool-gateway credentials
 * were issued for that run -- but the `codex_local` session never attached
 * the gateway MCP server, so `github_bot_whoami` and the other three tools
 * were never discoverable or callable from inside the run. The agent that
 * reported "tool not exposed" was correct; the plugin's global manifest
 * registration was never the failure.
 *
 * This suite keeps "global plugin registration" (fully within this repo's
 * control) and "per-session tool availability" (owned by Paperclip core's
 * adapter/runtime-MCP attachment path, tracked upstream at
 * paperclipai/paperclip#10346 and paperclipai/paperclip#10144) as two
 * INDEPENDENT, separately-computed signals, using the harness in
 * tests/helpers/session-tool-discovery.ts. It reproduces the incident state
 * (registered globally, absent from session discovery) and the healthy
 * state (registered AND discoverable), and proves discovery never leaks
 * tools without an explicit gateway-attachment signal -- so a green
 * "manifest registration" assertion alone can never be read as evidence
 * that any adapter (codex_local, hermes_local, or otherwise) exposes these
 * tools to an agent. That end-to-end proof requires a real gateway session
 * against a running Paperclip core instance, which this repo cannot produce;
 * see openwiki/guides/agent-identities-setup.md#tool-availability-in-agent-sessions.
 */
describe("global plugin registration vs per-session tool availability", () => {
  it("registers all four GitHub tools in the plugin manifest (global registration)", () => {
    expect(githubManifestTools.length).toBe(4);
    for (const tool of githubManifestTools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }
    expect(githubManifestTools.map((tool) => tool.name)).toContain("github_bot_whoami");
  });

  it("reproduces the incident: tools globally registered but absent from session discovery when the gateway never attached", () => {
    // Matches the live failure: ctx.runtimeMcp credentials were issued
    // (runtimeMcpPresent), but the codex_local adapter never attached the
    // gateway MCP server (gatewayAttached: false).
    const discovered = simulateSessionToolDiscovery(githubManifestTools, {
      runtimeMcpPresent: true,
      gatewayAttached: false,
    });

    expect(discovered).toEqual([]);
    expect(discovered).not.toContain("github_bot_whoami");
    // Registration itself is unaffected -- this is the crux of the bug the
    // agent's report correctly identified: registration succeeding is not
    // evidence the session can see the tool.
    expect(githubManifestTools.map((tool) => tool.name)).toContain("github_bot_whoami");
  });

  it("also fails closed when ctx.runtimeMcp is empty, even if the adapter otherwise attempts attachment", () => {
    const discovered = simulateSessionToolDiscovery(githubManifestTools, {
      runtimeMcpPresent: false,
      gatewayAttached: true,
    });

    expect(discovered).toEqual([]);
  });

  it("exposes github_bot_whoami through session discovery only in the healthy state (both signals true)", () => {
    const discovered = simulateSessionToolDiscovery(githubManifestTools, {
      runtimeMcpPresent: true,
      gatewayAttached: true,
    });

    expect(discovered).toEqual(githubManifestTools.map((tool) => tool.name));
    expect(discovered).toContain("github_bot_whoami");
  });

  it("documents the upstream ownership boundary for the real end-to-end attachment path", () => {
    const claim =
      "manifest registration proves global availability only; " +
      "per-session availability requires adapter runtime-MCP attachment " +
      "(tracked: paperclipai/paperclip#10346, paperclipai/paperclip#10144)";
    expect(claim).toContain("paperclipai/paperclip#10346");
    expect(claim).toContain("paperclipai/paperclip#10144");
  });
});
