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
 * globally, gateway never attached) and one unverified target specification
 * (gateway attached). The fixtures are independently authored data (see each
 * file's `provenance` block), not computed from this repo's source, which is what
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Ajv, type AnySchema } from "ajv";

const FIXTURE_SCHEMA_FILE = "session-tool-discovery.schema.json";
const FIXTURES_DIR = path.dirname(
  fileURLToPath(
    new URL(`../fixtures/session-tool-discovery/${FIXTURE_SCHEMA_FILE}`, import.meta.url),
  ),
);

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
  readonly globallyRegisteredTools?: readonly string[];
  readonly discoveredTools: readonly string[];
}

const ajv = new Ajv({ allErrors: true });
const fixtureSchema = JSON.parse(
  readFileSync(path.join(FIXTURES_DIR, FIXTURE_SCHEMA_FILE), "utf8"),
) as AnySchema;
const validateFixture = ajv.compile<SessionToolDiscoveryFixture>(fixtureSchema);

function assertSchemaValid(
  fixtureId: string,
  raw: unknown,
): asserts raw is SessionToolDiscoveryFixture {
  if (!validateFixture(raw)) {
    throw new Error(
      `Fixture ${fixtureId} does not match ${FIXTURE_SCHEMA_FILE}: ` +
        ajv.errorsText(validateFixture.errors, { separator: "; " }),
    );
  }
}

/** Load and schema-validate a single fixture by file stem (no extension). */
export function loadSessionToolDiscoveryFixture(fixtureFile: string): SessionToolDiscoveryFixture {
  const filePath = path.join(FIXTURES_DIR, `${fixtureFile}.json`);
  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  assertSchemaValid(fixtureFile, raw);
  return raw;
}

/**
 * Compare a fixture's session-visible tool list against a set of
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
