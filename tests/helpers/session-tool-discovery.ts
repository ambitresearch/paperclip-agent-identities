/**
 * DRO-1163 / paperclipai/paperclip#10346
 *
 * Loader/validator for captured session tool-discovery fixtures
 * (tests/fixtures/session-tool-discovery/*.json).
 *
 * Prior revisions of this harness *simulated* discovery as a pure function
 * of `githubManifestTools` plus two hand-set booleans -- that model could
 * never disagree with the manifest by construction, so a spec built on it
 * could stay green even if real `codex_local` sessions never exposed any
 * managed tool. Per review feedback (DRO-1163), the session-visible tool
 * list must come from a source that is independent of
 * `src/providers/github/manifest-tools.ts`.
 *
 * This module does NOT derive tool names from the manifest. It only loads
 * and schema-validates committed fixture files that record, for a given
 * adapter state, the literal tool names an agent session could observe via
 * `tools/list` -- one fixture for the reported incident state (registered
 * globally, gateway never attached) and one for the healthy state (gateway
 * attached). The fixtures are hand-authored/captured data (see each file's
 * `provenance` block), not computed from this repo's source, which is what
 * lets a spec assert real disagreement between "registered" and
 * "discoverable" instead of a tautology.
 *
 * This still cannot replace a live end-to-end run against a real Paperclip
 * core gateway session -- that requires a running core instance and is
 * tracked upstream at paperclipai/paperclip#10346 and
 * paperclipai/paperclip#10144. What this DOES guarantee within this repo:
 * the compatibility check compares two independently-sourced signals
 * (manifest registration vs. a captured discovery fixture) rather than one
 * signal computed from the other.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const FIXTURES_DIR = path.dirname(fileURLToPath(new URL("../fixtures/session-tool-discovery/session-tool-discovery.schema.json", import.meta.url)));

export interface SessionToolDiscoveryFixtureProvenance {
  readonly source: string;
  readonly capturedAt: string;
  readonly capturedBy: string;
  readonly note: string;
}

export type SessionToolDiscoveryFixtureStatus = "captured-incident" | "target-not-captured";

export interface SessionToolDiscoveryFixture {
  readonly fixtureId: string;
  readonly adapter: string;
  readonly status: SessionToolDiscoveryFixtureStatus;
  readonly provenance: SessionToolDiscoveryFixtureProvenance;
  readonly runtimeMcpPresent: boolean;
  readonly gatewayAttached: boolean;
  readonly discoveredTools: readonly string[];
}

const REQUIRED_TOP_LEVEL_KEYS = [
  "fixtureId",
  "adapter",
  "status",
  "provenance",
  "runtimeMcpPresent",
  "gatewayAttached",
  "discoveredTools",
] as const;

const VALID_STATUSES: readonly SessionToolDiscoveryFixtureStatus[] = [
  "captured-incident",
  "target-not-captured",
];

const REQUIRED_PROVENANCE_KEYS = ["source", "capturedAt", "capturedBy", "note"] as const;

function assertShape(fixtureId: string, raw: unknown): asserts raw is SessionToolDiscoveryFixture {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Fixture ${fixtureId} is not an object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of REQUIRED_TOP_LEVEL_KEYS) {
    if (!(key in record)) {
      throw new Error(`Fixture ${fixtureId} is missing required key "${key}"`);
    }
  }
  if (typeof record.fixtureId !== "string" || record.fixtureId.length === 0) {
    throw new Error(`Fixture ${fixtureId} has an invalid fixtureId`);
  }
  if (typeof record.adapter !== "string" || record.adapter.length === 0) {
    throw new Error(`Fixture ${fixtureId} has an invalid adapter`);
  }
  if (
    typeof record.status !== "string" ||
    !VALID_STATUSES.includes(record.status as SessionToolDiscoveryFixtureStatus)
  ) {
    throw new Error(`Fixture ${fixtureId} has an invalid status (must be one of ${VALID_STATUSES.join(", ")})`);
  }
  if (typeof record.runtimeMcpPresent !== "boolean") {
    throw new Error(`Fixture ${fixtureId} has a non-boolean runtimeMcpPresent`);
  }
  if (typeof record.gatewayAttached !== "boolean") {
    throw new Error(`Fixture ${fixtureId} has a non-boolean gatewayAttached`);
  }
  if (
    !Array.isArray(record.discoveredTools) ||
    !record.discoveredTools.every((tool) => typeof tool === "string" && tool.length > 0)
  ) {
    throw new Error(`Fixture ${fixtureId} has an invalid discoveredTools array`);
  }
  const provenance = record.provenance;
  if (!provenance || typeof provenance !== "object") {
    throw new Error(`Fixture ${fixtureId} is missing a provenance object`);
  }
  const provenanceRecord = provenance as Record<string, unknown>;
  for (const key of REQUIRED_PROVENANCE_KEYS) {
    if (typeof provenanceRecord[key] !== "string" || (provenanceRecord[key] as string).length === 0) {
      throw new Error(`Fixture ${fixtureId} provenance is missing/invalid key "${key}"`);
    }
  }
}

/** Load and schema-validate a single captured fixture by file stem (no extension). */
export function loadSessionToolDiscoveryFixture(fixtureFile: string): SessionToolDiscoveryFixture {
  const filePath = path.join(FIXTURES_DIR, `${fixtureFile}.json`);
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  assertShape(fixtureFile, raw);
  return raw;
}

/** Load every captured fixture in tests/fixtures/session-tool-discovery/. */
export function loadAllSessionToolDiscoveryFixtures(): SessionToolDiscoveryFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((file) => file.endsWith(".json") && !file.endsWith(".schema.json"))
    .map((file) => loadSessionToolDiscoveryFixture(file.replace(/\.json$/, "")));
}

/**
 * Compare a captured fixture's session-visible tool list against a set of
 * independently-sourced manifest tool names. Returns the manifest tools that
 * are registered but NOT present in the fixture's discovered set -- this is
 * the exact gap the incident hinged on.
 */
export function manifestToolsMissingFromDiscovery(
  manifestToolNames: readonly string[],
  fixture: SessionToolDiscoveryFixture,
): string[] {
  const discovered = new Set(fixture.discoveredTools);
  return manifestToolNames.filter((name) => !discovered.has(name));
}

/**
 * Guard against treating a hand-authored target/expected-state fixture as if
 * it were verified evidence of real adapter behavior. Throws unless the
 * fixture's status is "captured-incident" (an actually-observed result).
 */
export function assertFixtureIsCapturedEvidence(fixture: SessionToolDiscoveryFixture): void {
  if (fixture.status !== "captured-incident") {
    throw new Error(
      `Fixture ${fixture.fixtureId} has status "${fixture.status}", not "captured-incident" -- ` +
        "it cannot be used as evidence that a real codex_local session behaves this way.",
    );
  }
}
