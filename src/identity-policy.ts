// Backward-compatibility re-exports. GitHub identity schema/config resolution
// has moved into src/providers/github/config.ts (see Task 6 of the provider
// adapter refactor). This shim keeps existing imports of these symbols from
// "./identity-policy.js" working; it is removed in a later task once every
// consumer imports directly from the provider package.
export {
  parseGitHubBotIdentityPluginConfig,
  resolveAgentIdentityFromToolRunContext
} from "./providers/github/config.js";
export type {
  GitHubAgentIdentity,
  GitHubBotIdentityPluginConfig,
  ResolvedAgentIdentity
} from "./providers/github/config.js";

export interface GitHubRepoRef {
  owner: string;
  repo: string;
  fullName: string;
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
