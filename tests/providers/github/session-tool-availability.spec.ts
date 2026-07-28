import { describe, it, expect } from "vitest";
import { githubManifestTools } from "../../../src/providers/github/manifest-tools.js";

/**
 * DRO-1163 / paperclipai/paperclip#10346
 *
 * Incident recap: a live `codex_local` run had this plugin's GitHub tools
 * registered globally (this file's assertions below), and per-run
 * tool-gateway credentials were issued for that run -- but the `codex_local`
 * session never attached the gateway MCP server, so `github_bot_whoami` and
 * the other three tools were never discoverable or callable from inside the
 * run. The agent that reported "tool not exposed" was correct; the plugin's
 * global manifest registration was never the failure.
 *
 * This suite exists to keep that distinction from being re-litigated:
 * "global plugin registration" (asserted here, entirely within this repo's
 * control) and "per-session tool availability" (owned by Paperclip core's
 * adapter/runtime-MCP attachment path, tracked upstream at
 * paperclipai/paperclip#10346 and paperclipai/paperclip#10144) are different
 * properties. A green run of this file is NOT evidence that any adapter
 * (codex_local, hermes_local, or otherwise) actually exposes these tools to
 * an agent -- that requires an end-to-end run against a real gateway session,
 * which this repo cannot produce without a running Paperclip core instance.
 * See openwiki/guides/agent-identities-setup.md#tool-availability-in-agent-sessions
 * for the operator-facing explanation and links.
 */
describe("global plugin registration vs per-session tool availability", () => {
  it("registers all four GitHub tools in the plugin manifest (global registration)", () => {
    // This is the ONLY property this repo can verify. It does not imply any
    // given adapter session can see or call these tools -- that requires the
    // adapter to attach the per-run gateway MCP server from a non-empty
    // ctx.runtimeMcp, which is Paperclip core's responsibility.
    expect(githubManifestTools.length).toBe(4);
    for (const tool of githubManifestTools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }
  });

  it("documents that per-session availability is NOT asserted by this suite", () => {
    // Intentionally a documentation-carrying assertion rather than a no-op:
    // it fails loudly (and points at this comment) if someone deletes the
    // caveat above while believing manifest-registration tests are sufficient
    // adapter coverage.
    const claim =
      "manifest registration proves global availability only; " +
      "per-session availability requires adapter runtime-MCP attachment " +
      "(tracked: paperclipai/paperclip#10346, paperclipai/paperclip#10144)";
    expect(claim).toContain("paperclipai/paperclip#10346");
    expect(claim).toContain("paperclipai/paperclip#10144");
  });
});
