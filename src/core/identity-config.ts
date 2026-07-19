import { getIdentityKey } from "../shared/types.js";

export const BOT_IDENTITY_SETTINGS_VERSION = 5 as const;
export const LEGACY_SLACK_CLEANUP_TOMBSTONE_VERSION = 1 as const;

export interface GitHubIdentityFields {
  readonly username: string;
  readonly commitName?: string;
  readonly commitEmail?: string;
  readonly app?: {
    readonly credentialPropagationAgentIds?: readonly string[];
  };
}

export interface ExampleIdentityFields {
  readonly demoTokenSecretId: string;
}

// Shareable Slack install metadata only, never a credential. Bot token and
// signing-secret references live in company-scoped host config, while this
// settings projection contains only non-secret identity metadata.
export interface SlackIdentityFields {
  readonly teamId: string;
  readonly appId: string;
  readonly botUserId: string;
  readonly defaultChannel?: string;
}

export interface GitHubAgentIdentityConfig {
  readonly provider: "github";
  readonly id: string;
  readonly agentId: string;
  readonly label: string;
  readonly github: GitHubIdentityFields;
}

export interface ExampleAgentIdentityConfig {
  readonly provider: "example";
  readonly id: string;
  readonly agentId: string;
  readonly label: string;
  readonly example: ExampleIdentityFields;
}

export interface SlackAgentIdentityConfig {
  readonly provider: "slack";
  readonly id: string;
  readonly agentId: string;
  readonly label: string;
  readonly slack: SlackIdentityFields;
}

// Persistence-boundary discriminated union. New providers append a variant here.
// The runtime registry/pipeline stay provider-agnostic; only serialization enumerates.
export type AgentIdentityConfig =
  | GitHubAgentIdentityConfig
  | ExampleAgentIdentityConfig
  | SlackAgentIdentityConfig;

export interface LegacySlackSidecarCleanupTombstone {
  readonly version: typeof LEGACY_SLACK_CLEANUP_TOMBSTONE_VERSION;
  readonly cleanupId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly provider: "slack";
  readonly operation: "legacy-sidecar-delete";
  readonly source: "identity-delete" | "legacy-rebind";
  readonly expected?: {
    readonly botTokenSecretId: string;
    readonly signingSecretId?: string;
  };
}

export interface AgentIdentitySettingsState {
  readonly version: typeof BOT_IDENTITY_SETTINGS_VERSION;
  readonly identities: Record<string, AgentIdentityConfig>;
  readonly cleanupTombstones: Record<string, LegacySlackSidecarCleanupTombstone>;
}

export interface AgentIdentitySettingsStateV4 {
  readonly version: 4;
  readonly identities: Record<string, AgentIdentityConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | undefined {
  const text = readString(value);
  return text.length > 0 ? text : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => readString(item)).filter((item) => item.length > 0);
}

function isValidGitHubIdentityConfig(identity: GitHubAgentIdentityConfig): boolean {
  return identity.agentId.length > 0 && identity.label.length > 0 && identity.github.username.length > 0;
}

function migrateGitHubIdentityV3ToV4(raw: Record<string, unknown>): GitHubAgentIdentityConfig {
  const agentId = readString(raw.agentId);
  const github: {
    username: string;
    commitName?: string;
    commitEmail?: string;
    app?: { credentialPropagationAgentIds?: readonly string[] };
  } = { username: readString(raw.githubUsername) };

  const commitName = readOptionalString(raw.commitName);
  if (commitName) {
    github.commitName = commitName;
  }
  const commitEmail = readOptionalString(raw.commitEmail);
  if (commitEmail) {
    github.commitEmail = commitEmail;
  }
  const propagation = readStringArray(raw.githubAppCredentialPropagationAgentIds);
  if (propagation.length > 0) {
    github.app = { credentialPropagationAgentIds: propagation };
  }

  return {
    provider: "github",
    id: getIdentityKey(agentId, "github"),
    agentId,
    label: readString(raw.label),
    github,
  };
}

export function migrateSettingsStateToV4(raw: unknown): AgentIdentitySettingsStateV4 {
  const identities: Record<string, AgentIdentityConfig> = {};
  if (!isRecord(raw) || !isRecord(raw.identities)) {
    return { version: 4, identities };
  }

  for (const entry of Object.values(raw.identities)) {
    if (!isRecord(entry)) {
      continue;
    }
    // v3 only ever persisted github identities.
    if (readString(entry.provider) !== "github") {
      continue;
    }
    const migrated = migrateGitHubIdentityV3ToV4(entry);
    if (!isValidGitHubIdentityConfig(migrated)) {
      continue;
    }
    identities[migrated.id] = migrated;
  }

  return { version: 4, identities };
}

function isV4State(raw: unknown): raw is AgentIdentitySettingsStateV4 {
  return isRecord(raw) && raw.version === 4 && isRecord(raw.identities);
}

function normalizeV4Identity(raw: unknown): AgentIdentityConfig | null {
  if (!isRecord(raw)) return null;
  const id = readString(raw.id);
  const agentId = readString(raw.agentId);
  const label = readString(raw.label);
  if (!id || !agentId || !label) return null;

  if (raw.provider === "github" && isRecord(raw.github)) {
    const github: {
      username: string;
      commitName?: string;
      commitEmail?: string;
      app?: { credentialPropagationAgentIds?: readonly string[] };
    } = { username: readString(raw.github.username) };
    if (!github.username) return null;
    const commitName = readOptionalString(raw.github.commitName);
    if (commitName) github.commitName = commitName;
    const commitEmail = readOptionalString(raw.github.commitEmail);
    if (commitEmail) github.commitEmail = commitEmail;
    if (isRecord(raw.github.app)) {
      const propagation = readStringArray(raw.github.app.credentialPropagationAgentIds);
      if (propagation.length > 0) github.app = { credentialPropagationAgentIds: propagation };
    }
    return { provider: "github", id: getIdentityKey(agentId, "github"), agentId, label, github };
  }

  if (raw.provider === "example" && isRecord(raw.example)) {
    const demoTokenSecretId = readString(raw.example.demoTokenSecretId);
    if (!demoTokenSecretId) return null;
    return { provider: "example", id: getIdentityKey(agentId, "example"), agentId, label, example: { demoTokenSecretId } };
  }

  if (raw.provider === "slack" && isRecord(raw.slack)) {
    const teamId = readString(raw.slack.teamId);
    const appId = readString(raw.slack.appId);
    const botUserId = readString(raw.slack.botUserId);
    if (!teamId || !appId || !botUserId) return null;
    const slack: { teamId: string; appId: string; botUserId: string; defaultChannel?: string } = {
      teamId,
      appId,
      botUserId,
    };
    const defaultChannel = readOptionalString(raw.slack.defaultChannel);
    if (defaultChannel) slack.defaultChannel = defaultChannel;
    return { provider: "slack", id: getIdentityKey(agentId, "slack"), agentId, label, slack };
  }

  return null;
}

function normalizeV4State(raw: unknown): AgentIdentitySettingsStateV4 | null {
  if (!isV4State(raw)) return null;
  const identities: Record<string, AgentIdentityConfig> = {};
  for (const entry of Object.values(raw.identities)) {
    const identity = normalizeV4Identity(entry);
    if (identity) identities[identity.id] = identity;
  }
  return { version: 4, identities };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeCleanupTombstone(raw: unknown): LegacySlackSidecarCleanupTombstone | null {
  if (!isRecord(raw)) return null;
  const cleanupId = readString(raw.cleanupId);
  const companyId = readString(raw.companyId);
  const agentId = readString(raw.agentId);
  const source = raw.source === "identity-delete" || raw.source === "legacy-rebind"
    ? raw.source
    : null;
  if (
    raw.version !== LEGACY_SLACK_CLEANUP_TOMBSTONE_VERSION
    || !cleanupId
    || !companyId
    || !agentId
    || raw.provider !== "slack"
    || raw.operation !== "legacy-sidecar-delete"
    || !source
  ) {
    return null;
  }

  let expected: LegacySlackSidecarCleanupTombstone["expected"];
  if (raw.expected !== undefined) {
    if (!isRecord(raw.expected)) return null;
    const botTokenSecretId = readString(raw.expected.botTokenSecretId);
    const signingSecretId = readOptionalString(raw.expected.signingSecretId);
    if (!isUuid(botTokenSecretId) || (signingSecretId && !isUuid(signingSecretId))) return null;
    expected = {
      botTokenSecretId,
      ...(signingSecretId ? { signingSecretId } : {}),
    };
  }

  return {
    version: LEGACY_SLACK_CLEANUP_TOMBSTONE_VERSION,
    cleanupId,
    companyId,
    agentId,
    provider: "slack",
    operation: "legacy-sidecar-delete",
    source,
    ...(expected ? { expected } : {}),
  };
}

function normalizeV5State(raw: unknown): AgentIdentitySettingsState | null {
  if (
    !isRecord(raw)
    || raw.version !== BOT_IDENTITY_SETTINGS_VERSION
    || !isRecord(raw.identities)
    || !isRecord(raw.cleanupTombstones)
  ) {
    return null;
  }

  const identities: Record<string, AgentIdentityConfig> = {};
  for (const entry of Object.values(raw.identities)) {
    const identity = normalizeV4Identity(entry);
    if (identity) identities[identity.id] = identity;
  }

  const cleanupTombstones: Record<string, LegacySlackSidecarCleanupTombstone> = {};
  for (const entry of Object.values(raw.cleanupTombstones)) {
    const tombstone = normalizeCleanupTombstone(entry);
    if (tombstone) cleanupTombstones[tombstone.cleanupId] = tombstone;
  }

  return { version: BOT_IDENTITY_SETTINGS_VERSION, identities, cleanupTombstones };
}

export function migrateSettingsStateToV5(raw: unknown): AgentIdentitySettingsState {
  const v4 = normalizeV4State(raw);
  return {
    version: BOT_IDENTITY_SETTINGS_VERSION,
    identities: v4?.identities ?? {},
    cleanupTombstones: {},
  };
}

// Migration ladder. Persisted v3 and v4 states are normalized into v5 before use.
export function normalizeSettingsState(raw: unknown): AgentIdentitySettingsState {
  const v5 = normalizeV5State(raw);
  if (v5) return v5;
  const v4 = normalizeV4State(raw);
  if (v4) return migrateSettingsStateToV5(v4);
  if (isRecord(raw) && raw.version === 3) {
    return migrateSettingsStateToV5(migrateSettingsStateToV4(raw));
  }
  return { version: BOT_IDENTITY_SETTINGS_VERSION, identities: {}, cleanupTombstones: {} };
}
