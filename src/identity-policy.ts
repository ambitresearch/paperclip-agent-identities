import { z, type ToolRunContext } from "@paperclipai/plugin-sdk";

export const DEFAULT_ALLOWED_OWNER_PATTERNS = ["^roshangautam$"] as const;
const HARD_ALLOWED_OWNER = "roshangautam";

const githubIdentitySchema = z.object({
  label: z.string().trim().min(1),
  githubUsername: z.string().trim().min(1),
  tokenSecretRef: z.string().trim().min(1).optional(),
  allowedOwnerPatterns: z.array(z.string().trim().min(1)).default([...DEFAULT_ALLOWED_OWNER_PATTERNS]),
  allowedRepos: z.array(z.string().trim().min(1)).optional(),
  commitName: z.string().trim().min(1).optional(),
  commitEmail: z.string().trim().min(1).optional()
});

const pluginConfigSchema = z.object({
  identities: z.record(z.string().trim().min(1), githubIdentitySchema)
});

export type GitHubAgentIdentity = z.infer<typeof githubIdentitySchema>;
export type GitHubBotIdentityPluginConfig = z.infer<typeof pluginConfigSchema>;

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
  return pluginConfigSchema.parse(rawConfig);
}

export function resolveAgentIdentityFromToolRunContext(
  rawConfig: unknown,
  runContext: ToolRunContext
): ResolvedAgentIdentity {
  const parsed = pluginConfigSchema.safeParse(rawConfig);
  if (!parsed.success) {
    throw new Error(
      `Invalid GitHub bot identity config: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  }

  const identity = parsed.data.identities[runContext.agentId];
  if (!identity) {
    throw new Error(
      `Missing GitHub bot identity config for agent '${runContext.agentId}'. Expected identities.${runContext.agentId}.`
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

  if (normalizedRepo.owner !== HARD_ALLOWED_OWNER) {
    return {
      allowed: false,
      reason: `Repository owner '${normalizedRepo.owner}' is outside MVP allowed scope '${HARD_ALLOWED_OWNER}/*'`,
      repo: normalizedRepo
    };
  }

  const ownerPatterns = identity.allowedOwnerPatterns;

  let ownerAllowed = false;
  for (const pattern of ownerPatterns) {
    try {
      if (new RegExp(pattern).test(normalizedRepo.owner)) {
        ownerAllowed = true;
        break;
      }
    } catch {
      return { allowed: false, reason: `Invalid owner pattern '${pattern}'`, repo: normalizedRepo };
    }
  }

  if (!ownerAllowed) {
    return {
      allowed: false,
      reason: `Repository owner '${normalizedRepo.owner}' does not match allowedOwnerPatterns`,
      repo: normalizedRepo
    };
  }

  if (identity.allowedRepos && identity.allowedRepos.length > 0) {
    const normalizedAllowedRepos = identity.allowedRepos
      .map(normalizeGitHubRepoRef)
      .filter((value): value is GitHubRepoRef => Boolean(value));
    const allowedSet = new Set(normalizedAllowedRepos.map((entry) => entry.fullName));
    if (!allowedSet.has(normalizedRepo.fullName)) {
      return {
        allowed: false,
        reason: `Repository '${normalizedRepo.fullName}' is not present in allowedRepos`,
        repo: normalizedRepo
      };
    }
  }

  return { allowed: true, reason: "Repository allowed", repo: normalizedRepo };
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
