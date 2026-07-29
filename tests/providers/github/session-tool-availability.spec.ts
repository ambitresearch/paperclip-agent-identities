import { describe, it, expect } from "vitest";
import manifest from "../../../src/manifest.js";
import { loadSessionToolDiscoveryFixture } from "../../helpers/session-tool-discovery.js";

/**
 * DRO-1163 / paperclipai/paperclip#10346
 *
 * Incident recap: a live `codex_local` run had this plugin's GitHub tools
 * registered globally and per-run tool-gateway credentials were issued. The
 * managed MCP config was injected, but it used Codex's unsupported `headers`
 * key, so Codex discarded the gateway credential and the agent reported
 * `github_bot_whoami` unavailable. Whether an unauthenticated request reached
 * the gateway was not captured.
 *
 * IMPORTANT SCOPE NOTE (per DRO-1163 review): this repo cannot stand up
 * Paperclip core's `codex_local` adapter or gateway, so it cannot verify a
 * healthy session. The fixture intentionally omits uncaptured default tool
 * names and records only facts established by the incident and core follow-up.
 * End-to-end verification remains owned by paperclipai/paperclip#10346.
 */
describe("global plugin registration vs per-session tool availability", () => {
  const manifestToolNames = (manifest.tools as ReadonlyArray<{ name: string }>).map(
    (tool) => tool.name,
  );
  const registeredGitHubToolNames = manifestToolNames.filter((name) =>
    name.startsWith("github_bot_"),
  );
  it("still composes the captured incident-era GitHub tools into the final plugin manifest", () => {
    expect(registeredGitHubToolNames).toEqual(expect.arrayContaining([
      "github_bot_whoami",
      "github_bot_create_pull_request",
      "github_bot_push_branch",
      "github_bot_submit_pull_request_review",
    ]));
    expect(new Set(registeredGitHubToolNames).size).toBe(registeredGitHubToolNames.length);
  });

  it("keeps global registration separate from the captured authentication failure", () => {
    const incident = loadSessionToolDiscoveryFixture("incident-codex_local");

    expect(incident.status).toBe("captured-incident");
    expect(incident.adapter).toBe("codex_local");
    expect(incident.runtimeMcpPresent).toBe(true);
    expect(incident.managedGatewayConfigInjected).toBe(true);
    expect(incident.gatewayTransportReached).toBe("unknown");
    expect(incident.gatewayCredentialUsed).toBe(false);
    expect(incident.reportedUnavailableTools).toEqual(["github_bot_whoami"]);

    const incidentRegisteredGitHubToolNames = incident.globallyRegisteredTools.filter(
      (name) => name.startsWith("github_bot_"),
    );
    expect(incidentRegisteredGitHubToolNames).toEqual([
      "github_bot_whoami",
      "github_bot_create_pull_request",
      "github_bot_push_branch",
      "github_bot_submit_pull_request_review",
    ]);
    expect(registeredGitHubToolNames).toEqual(
      expect.arrayContaining(incidentRegisteredGitHubToolNames),
    );

    expect(incident.globallyRegisteredTools).toEqual(
      expect.arrayContaining([...incident.reportedUnavailableTools]),
    );
  });
});
