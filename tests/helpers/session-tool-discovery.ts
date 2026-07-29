/**
 * DRO-1163 / paperclipai/paperclip#10346
 *
 * Loader/validator for captured session tool-availability incidents
 * (tests/fixtures/session-tool-discovery/*.json).
 *
 * Prior revisions of this harness *simulated* discovery as a pure function
 * of `githubManifestTools` plus two hand-set booleans -- that model could
 * never disagree with the manifest by construction. A later revision then
 * invented a literal `tools/list` capture that the incident record did not
 * contain. This fixture instead records only independently established facts:
 * global registration, the unavailable tool the agent reported, config
 * injection, credential use, and whether transport reachability was known.
 *
 * This cannot replace a live end-to-end run against a real Paperclip core
 * gateway session. That remains tracked at paperclipai/paperclip#10346.
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

export interface SessionToolDiscoveryFixture {
  readonly fixtureId: string;
  readonly adapter: string;
  readonly status: "captured-incident";
  readonly provenance: SessionToolDiscoveryFixtureProvenance;
  readonly runtimeMcpPresent: boolean;
  readonly managedGatewayConfigInjected: boolean;
  readonly gatewayTransportReached: "yes" | "no" | "unknown";
  readonly gatewayCredentialUsed: boolean;
  readonly globallyRegisteredTools: readonly string[];
  readonly reportedUnavailableTools: readonly string[];
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
