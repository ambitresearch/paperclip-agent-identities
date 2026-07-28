import { describe, it, expect } from "vitest";
import { githubManifestTools } from "../../../src/providers/github/manifest-tools.js";
import {
  loadSessionToolDiscoveryFixture,
  manifestToolsMissingFromDiscovery,
  assertFixtureIsCapturedEvidence,
} from "../../helpers/session-tool-discovery.js";

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
 * IMPORTANT SCOPE NOTE (per DRO-1163 review): this repo cannot stand up
 * Paperclip core's `codex_local` adapter or gateway, so it cannot capture or
 * verify a real "healthy" session result. `tests/fixtures/session-tool-discovery/`
 * contains exactly one *captured* fixture (`incident-codex_local`, status
 * `captured-incident`) reproducing the actually-observed incident, and one
 * *target-spec* fixture (`target-codex_local`, status `target-not-captured`)
 * that only documents the shape of the desired post-fix state -- it is NOT
 * evidence that codex_local attachment works, and every assertion below that
 * touches it is scoped to "this is the target shape", never "this is proven
 * to work". The real end-to-end fix, its regression coverage, and gateway
 * telemetry are owned upstream by paperclipai/paperclip#10346 /
 * paperclipai/paperclip#10144 and remain unresolved; this suite cannot close
 * that gap, only prevent this repo's own manifest-vs-discovery check from
 * being tautological.
 */
describe("global plugin registration vs per-session tool availability", () => {
  const manifestToolNames = githubManifestTools.map((tool) => tool.name);

  it("registers all four GitHub tools in the plugin manifest (global registration)", () => {
    expect(githubManifestTools.length).toBe(4);
    for (const tool of githubManifestTools) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
    }
    expect(manifestToolNames).toContain("github_bot_whoami");
  });

  it("reproduces the incident from a CAPTURED fixture: tools globally registered but absent from the session's actual tools/list when the gateway never attached", () => {
    const incident = loadSessionToolDiscoveryFixture("incident-codex_local");
    assertFixtureIsCapturedEvidence(incident);

    expect(incident.adapter).toBe("codex_local");
    expect(incident.runtimeMcpPresent).toBe(true);
    expect(incident.gatewayAttached).toBe(false);

    // The fixture's discoveredTools come from a captured/hand-transcribed
    // record of the incident, not from this repo's manifest -- so this
    // assertion can genuinely fail if that captured session ever included
    // any of these tool names.
    expect(incident.discoveredTools).not.toContain("github_bot_whoami");

    const missing = manifestToolsMissingFromDiscovery(manifestToolNames, incident);
    expect(missing.sort()).toEqual([...manifestToolNames].sort());

    // Registration itself is unaffected -- this is the crux of the bug the
    // agent's report correctly identified: registration succeeding is not
    // evidence the session can see the tool.
    expect(manifestToolNames).toContain("github_bot_whoami");
  });

  it("documents (but does NOT verify) the target post-fix shape: the target-spec fixture is explicitly unverified", () => {
    const target = loadSessionToolDiscoveryFixture("target-codex_local");

    // This fixture is a specification, not evidence -- assert that fact
    // rather than treating its contents as a proven healthy state.
    expect(target.status).toBe("target-not-captured");
    expect(() => assertFixtureIsCapturedEvidence(target)).toThrow(/cannot be used as evidence/);

    // The shape itself is still useful to keep aligned with the manifest so
    // the target spec doesn't silently drift, but this is NOT a claim that
    // any real codex_local session has ever produced this list.
    const missing = manifestToolsMissingFromDiscovery(manifestToolNames, target);
    expect(missing).toEqual([]);
  });

  it("keeps the incident and target fixtures independent, distinctly-sourced records, not two branches of the same computation", () => {
    const incident = loadSessionToolDiscoveryFixture("incident-codex_local");
    const target = loadSessionToolDiscoveryFixture("target-codex_local");

    expect(incident.status).toBe("captured-incident");
    expect(target.status).toBe("target-not-captured");
    expect(incident.gatewayAttached).not.toBe(target.gatewayAttached);
    expect(incident.discoveredTools).not.toEqual(target.discoveredTools);
  });

  it("documents the upstream ownership boundary for the real end-to-end attachment path", () => {
    const claim =
      "manifest registration proves global availability only; " +
      "per-session availability requires adapter runtime-MCP attachment, " +
      "which remains UNVERIFIED by this repo pending upstream fixes " +
      "(tracked: paperclipai/paperclip#10346, paperclipai/paperclip#10144)";
    expect(claim).toContain("paperclipai/paperclip#10346");
    expect(claim).toContain("paperclipai/paperclip#10144");
    expect(claim).toContain("UNVERIFIED");
  });
});
