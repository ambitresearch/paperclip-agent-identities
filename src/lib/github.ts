const GITHUB_HOST = "github.com";

function splitOwnerRepo(ownerAndRepo: string): { owner: string; repo: string } | null {
  const segments = ownerAndRepo
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length !== 2) {
    return null;
  }

  const [owner, repo] = segments;
  if (!owner || !repo) {
    return null;
  }

  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

export function normalizeGitHubRepo(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const sshMatch = /^git@github\.com:(.+)$/i.exec(trimmed);
  if (sshMatch) {
    const parsed = splitOwnerRepo(stripGitSuffix(sshMatch[1].replace(/\/+$/, "")));
    return parsed ? `${parsed.owner}/${parsed.repo}` : null;
  }

  const likelyOwnerRepo = !trimmed.includes("://") && !trimmed.startsWith("git@");
  if (likelyOwnerRepo) {
    const parsed = splitOwnerRepo(stripGitSuffix(trimmed.replace(/\/+$/, "")));
    return parsed ? `${parsed.owner}/${parsed.repo}` : null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return null;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== GITHUB_HOST) {
    return null;
  }

  const path = stripGitSuffix(parsedUrl.pathname.replace(/\/+$/, ""));
  const parsed = splitOwnerRepo(path);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
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
