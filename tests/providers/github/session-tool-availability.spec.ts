import { describe, it, expect } from "vitest";
import { githubManifestTools } from "../../../src/providers/github/manifest-tools.js";
import {
  loadSessionToolDiscoveryFixture,
  manifestToolsMissingFromDiscovery,
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
 * Prior revisions of this suite modeled "session discovery" as a pure
 * function of `githubManifestTools` itself plus two hand-set booleans. That
 * model could never disagree with the manifest by construction, so it
 * stayed green even if real `codex_local` discovery were broken -- exactly
 * the regression this tracker requires the check to catch. This revision
 * instead compares `githubManifestTools` (this repo's global-registration
 * signal, fully in this repo's control) against captured fixtures under
 * tests/fixtures/session-tool-discovery/ that record a session's *actual*
 * `tools/list`-observable content for a given adapter state, independent of
 * this repo's manifest source (see each fixture's `provenance` block for how
 * it was captured/authored). The two signals are computed from genuinely
 * different sources, so this suite fails if the fixtures ever showed full
 * discovery for the incident state, and it stays true to the incident by
 * asserting the *specific* missing tools rather than an aggregate boolean.
 *
 * A real running-core, live-session capture is still owned upstream by
 * paperclipai/paperclip#10346 and paperclipai/paperclip#10144 -- this repo
 * cannot stand up Paperclip core's `codex_local` adapter, so the fixtures
 * are the closest independent proxy available locally. See
 * openwiki/guides/agent-identities-setup.md#tool-availability-in-agent-sessions
 * for the operator-facing writeup of this same boundary.
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

  it("reproduces the incident from a captured fixture: tools globally registered but absent from the session's actual tools/list when the gateway never attached", () => {
    const incident = loadSessionToolDiscoveryFixture("incident-codex_local");

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

  it("shows all four GitHub tools discoverable in the captured healthy-state fixture (gateway attached)", () => {
    const healthy = loadSessionToolDiscoveryFixture("healthy-codex_local");

    expect(healthy.adapter).toBe("codex_local");
    expect(healthy.runtimeMcpPresent).toBe(true);
    expect(healthy.gatewayAttached).toBe(true);

    const missing = manifestToolsMissingFromDiscovery(manifestToolNames, healthy);
    expect(missing).toEqual([]);

    for (const name of manifestToolNames) {
      expect(healthy.discoveredTools).toContain(name);
    }
  });

  it("keeps the incident and healthy fixtures independent captures, not two branches of the same computation", () => {
    const incident = loadSessionToolDiscoveryFixture("incident-codex_local");
    const healthy = loadSessionToolDiscoveryFixture("healthy-codex_local");

    // Both fixtures report runtimeMcpPresent: true (credentials were issued
    // in both cases) -- the only thing that differs is gatewayAttached,
    // matching the incident's actual root cause. These are read from each
    // fixture's own recorded fields (not anything computed from src/), so
    // this keeps the two fixtures honest as independent captures rather
    // than two branches of a shared formula.
    expect(incident.runtimeMcpPresent).toBe(healthy.runtimeMcpPresent);
    expect(incident.gatewayAttached).not.toBe(healthy.gatewayAttached);
    expect(incident.discoveredTools).not.toEqual(healthy.discoveredTools);
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
