import { getIdentityKey } from "../shared/types.js";

export const BOT_IDENTITY_SETTINGS_VERSION = 4 as const;

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

// Persistence-boundary discriminated union. New providers append a variant here.
// The runtime registry/pipeline stay provider-agnostic; only serialization enumerates.
export type AgentIdentityConfig = GitHubAgentIdentityConfig | ExampleAgentIdentityConfig;

export interface AgentIdentitySettingsState {
  readonly version: typeof BOT_IDENTITY_SETTINGS_VERSION;
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

export function migrateSettingsStateToV4(raw: unknown): AgentIdentitySettingsState {
  const identities: Record<string, AgentIdentityConfig> = {};
  if (!isRecord(raw) || !isRecord(raw.identities)) {
    return { version: BOT_IDENTITY_SETTINGS_VERSION, identities };
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
    if (
      migrated.agentId.length === 0 ||
      migrated.label.length === 0 ||
      migrated.github.username.length === 0
    ) {
      continue;
    }
    identities[migrated.id] = migrated;
  }

  return { version: BOT_IDENTITY_SETTINGS_VERSION, identities };
}

function isV4State(raw: unknown): raw is AgentIdentitySettingsState {
  return isRecord(raw) && raw.version === BOT_IDENTITY_SETTINGS_VERSION && isRecord(raw.identities);
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

  return null;
}

function normalizeV4State(raw: unknown): AgentIdentitySettingsState | null {
  if (!isV4State(raw)) return null;
  const identities: Record<string, AgentIdentityConfig> = {};
  for (const entry of Object.values(raw.identities)) {
    const identity = normalizeV4Identity(entry);
    if (identity) identities[identity.id] = identity;
  }
  return { version: BOT_IDENTITY_SETTINGS_VERSION, identities };
}

// Migration ladder. A future v4 -> v5 step slots in as another `if` branch above the reset.
export function normalizeSettingsState(raw: unknown): AgentIdentitySettingsState {
  const v4 = normalizeV4State(raw);
  if (v4) return v4;
  if (isRecord(raw) && raw.version === 3) {
    return migrateSettingsStateToV4(raw);
  }
  return { version: BOT_IDENTITY_SETTINGS_VERSION, identities: {} };
}
