import { z, type ToolRunContext } from "@paperclipai/plugin-sdk";
import { DEFAULT_ALLOWED_REPO_PATTERNS } from "./shared/types.js";

const githubIdentitySchema = z.object({
  label: z.string().trim().min(1),
  githubUsername: z.string().trim().min(1),
  tokenSecretRef: z.string().trim().min(1).optional(),
  allowedRepoPatterns: z.array(z.string().trim().min(1)).optional(),
  /** Compatibility config from before owner/repo policy was unified. */
  allowedOwnerPatterns: z.array(z.string().trim().min(1)).optional(),
  /** Compatibility config from before owner/repo policy was unified. */
  allowedRepos: z.array(z.string().trim().min(1)).optional(),
  commitName: z.string().trim().min(1).optional(),
  commitEmail: z.string().trim().min(1).optional()
});

const pluginConfigSchema = z.object({
  identities: z.record(z.string().trim().min(1), githubIdentitySchema)
});

type ParsedGitHubAgentIdentity = z.infer<typeof githubIdentitySchema>;
type ParsedGitHubBotIdentityPluginConfig = z.infer<typeof pluginConfigSchema>;

export type GitHubAgentIdentity = Omit<ParsedGitHubAgentIdentity, "allowedRepoPatterns"> & {
  allowedRepoPatterns: string[];
};

export type GitHubBotIdentityPluginConfig = {
  identities: Record<string, GitHubAgentIdentity>;
};

export interface ResolvedAgentIdentity {
  agentId: string;
  identity: GitHubAgentIdentity;
}

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  fullName: string;
}

export interface RepoPolicyDecision {
  allowed: boolean;
  reason: string;
  repo?: GitHubRepoRef;
}

export function parseGitHubBotIdentityPluginConfig(rawConfig: unknown): GitHubBotIdentityPluginConfig {
  return normalizePluginConfig(pluginConfigSchema.parse(rawConfig));
}

export function resolveAgentIdentityFromToolRunContext(
  rawConfig: unknown,
  runContext: ToolRunContext
): ResolvedAgentIdentity {
  const parsed = pluginConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(
      `Invalid agent identity config: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }

  const config = normalizePluginConfig(parsed.data);
  const identity = config.identities[runContext.agentId];
  if (!identity) {
    throw new Error(
      `Missing agent identity config for agent '${runContext.agentId}'. Expected identities.${runContext.agentId}.`
    );
  }

  return { agentId: runContext.agentId, identity };
}

export function normalizeGitHubRepoRef(input: string): GitHubRepoRef | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const scpMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (scpMatch) {
    return buildRepoRef(scpMatch[1], scpMatch[2]);
  }

  const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshUrlMatch) {
    return buildRepoRef(sshUrlMatch[1], sshUrlMatch[2]);
  }

  const gitProtocolMatch = trimmed.match(/^git:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (gitProtocolMatch) {
    return buildRepoRef(gitProtocolMatch[1], gitProtocolMatch[2]);
  }

  const asUrl = parseGithubUrl(trimmed);
  if (asUrl) {
    return asUrl;
  }

  if (isUrlLikeRepoRef(trimmed)) {
    return null;
  }

  return parseOwnerRepoPair(trimmed);
}

export function evaluateRepoPolicy(identity: GitHubAgentIdentity, repoInput: string): RepoPolicyDecision {
  const normalizedRepo = normalizeGitHubRepoRef(repoInput);
  if (!normalizedRepo) {
    return { allowed: false, reason: "Invalid repository format" };
  }

  const patterns = identity.allowedRepoPatterns;
  if (patterns.length === 0) {
    return { allowed: false, reason: "No allowed repository patterns configured", repo: normalizedRepo };
  }

  for (const pattern of patterns) {
    const matcher = repoPatternToRegExp(pattern);
    if (matcher instanceof Error) {
      return { allowed: false, reason: matcher.message, repo: normalizedRepo };
    }
    if (matcher.test(normalizedRepo.fullName)) {
      return { allowed: true, reason: "Repository allowed", repo: normalizedRepo };
    }
  }

  return {
    allowed: false,
    reason: `Repository '${normalizedRepo.fullName}' does not match allowedRepoPatterns`,
    repo: normalizedRepo
  };
}

function normalizePluginConfig(config: ParsedGitHubBotIdentityPluginConfig): GitHubBotIdentityPluginConfig {
  const identities: Record<string, GitHubAgentIdentity> = {};
  for (const [agentId, identity] of Object.entries(config.identities)) {
    identities[agentId] = {
      ...identity,
      allowedRepoPatterns: resolveAllowedRepoPatterns(identity)
    };
  }
  return { identities };
}

function resolveAllowedRepoPatterns(identity: ParsedGitHubAgentIdentity): string[] {
  if (identity.allowedRepoPatterns !== undefined) {
    return dedupeStrings(identity.allowedRepoPatterns);
  }

  if (identity.allowedRepos !== undefined) {
    return dedupeStrings(identity.allowedRepos.map((repo) => normalizeGitHubRepoRef(repo)?.fullName ?? repo.trim().toLowerCase()));
  }

  if (identity.allowedOwnerPatterns !== undefined) {
    return legacyOwnerPatternsToRepoPatterns(identity.allowedOwnerPatterns);
  }

  return [...DEFAULT_ALLOWED_REPO_PATTERNS];
}

function legacyOwnerPatternsToRepoPatterns(ownerPatterns: string[]): string[] {
  const converted = ownerPatterns
    .map((pattern) => exactLegacyOwnerPatternToRepoPattern(pattern))
    .filter((pattern): pattern is string => Boolean(pattern));
  return dedupeStrings(converted);
}

function exactLegacyOwnerPatternToRepoPattern(pattern: string): string | null {
  const trimmed = pattern.trim();
  if (trimmed === ".*" || trimmed === "^.*$" || trimmed === "*") {
    return "*/*";
  }
  const exactMatch = trimmed.match(/^\^?([a-zA-Z0-9][a-zA-Z0-9-]*)\$?$/);
  return exactMatch ? `${exactMatch[1].toLowerCase()}/*` : null;
}

function dedupeStrings(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, entries) => entries.indexOf(value) === index);
}

function repoPatternToRegExp(pattern: string): RegExp | Error {
  const normalized = pattern.trim().toLowerCase();
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return new Error(`Invalid allowed repository pattern '${pattern}'. Use 'owner/repo', e.g. '*/*'.`);
  }

  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const globbed = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${globbed}$`);
}

function isUrlLikeRepoRef(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^[^/\s]+\.[^/\s]+\//.test(value);
}

function parseGithubUrl(value: string): GitHubRepoRef | null {
  let normalized = value;
  if (/^github\.com\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  if (!/^https?:\/\//i.test(normalized)) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      return null;
    }

    const parts = parsed.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length < 2) {
      return null;
    }

    return buildRepoRef(parts[0], parts[1]);
  } catch {
    return null;
  }
}

function parseOwnerRepoPair(value: string): GitHubRepoRef | null {
  const cleaned = value.replace(/^\/+/, "");
  const parts = cleaned.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  return buildRepoRef(parts[0], parts[1]);
}

function buildRepoRef(ownerRaw: string, repoRaw: string): GitHubRepoRef | null {
  const owner = ownerRaw.trim().toLowerCase();
  const repo = repoRaw
    .trim()
    .replace(/\.git$/i, "")
    .toLowerCase();

  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`
  };
}
