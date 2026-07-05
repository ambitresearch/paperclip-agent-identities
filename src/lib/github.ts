import { normalizeGitHubRepoRef } from "../identity-policy.js";

export function normalizeGitHubRepo(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (/^git@/i.test(trimmed) && !/^git@github\.com:/i.test(trimmed)) {
    return null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.hostname.toLowerCase() !== "github.com") {
        return null;
      }
      const pathParts = parsed.pathname
        .split("/")
        .map((part) => part.trim())
        .filter(Boolean);
      if (pathParts.length < 2) {
        return null;
      }
    } catch {
      return null;
    }
  }

  return normalizeGitHubRepoRef(trimmed)?.fullName ?? null;
}

function normalizePolicyEntry(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  if (trimmed.endsWith("/*")) {
    const owner = trimmed.slice(0, -2);
    return owner ? `${owner}/*` : null;
  }

  return normalizeGitHubRepo(trimmed);
}

export function isRepoAllowed(repoInput: string, allowedRepos: readonly string[]): boolean {
  const normalizedRepo = normalizeGitHubRepo(repoInput);
  if (!normalizedRepo) {
    return false;
  }

  const [owner] = normalizedRepo.split("/");
  if (!owner) {
    return false;
  }

  return allowedRepos.some((entry) => {
    const normalizedEntry = normalizePolicyEntry(entry);
    if (!normalizedEntry) {
      return false;
    }

    if (normalizedEntry.endsWith("/*")) {
      return normalizedEntry.slice(0, -2) === owner;
    }

    return normalizedEntry === normalizedRepo;
  });
}
