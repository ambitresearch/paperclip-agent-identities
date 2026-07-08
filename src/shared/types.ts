export type BotIdentityConfig = {
  agentId: string;
  label: string;
  githubUsername: string;
  allowedRepoPatterns?: string[];
  /** Compatibility input for settings saved before repository patterns were unified. */
  allowedOwnerPattern?: string;
  /** Compatibility input for settings saved before repository patterns were unified. */
  allowedRepos?: string[];
  githubAppCredentialPropagationAgentIds?: string[];
  commitName?: string;
  commitEmail?: string;
};

export type BotIdentityGitHubAppCredentialConfig = {
  appId?: string;
  installationId?: string;
  privateKeySecretId?: string;
  privateKeyFile?: string;
};

export type BotIdentityCredentialConfig = {
  /** Fallback token secret source. Prefer githubApp. */
  secretId?: string;
  /** Fallback short-lived token file source. Prefer githubApp. */
  tokenFile?: string;
  githubApp?: BotIdentityGitHubAppCredentialConfig;
};

export type BotIdentitySettingsState = {
  version: 2;
  identities: Record<string, BotIdentityConfig>;
};

export type BotIdentitySettingsEntry = BotIdentityConfig & {
  credential?: BotIdentityCredentialConfig;
  credentialStatus: "configured" | "missing" | "sidecar-unavailable";
};

export type BotIdentitySettingsData = {
  version: 2;
  identities: BotIdentitySettingsEntry[];
  credentialSidecarPath: string;
  credentialSidecarError?: string;
};

export type SaveBotIdentityConfigInput = BotIdentityConfig & {
  credential?: BotIdentityCredentialConfig;
};

export type DeleteBotIdentityConfigInput = {
  agentId: string;
};

export const DEFAULT_ALLOWED_REPO_PATTERNS = ["roshangautam/*"] as const;
export const DEFAULT_ALLOWED_REPO_PATTERN = DEFAULT_ALLOWED_REPO_PATTERNS[0];
/** Compatibility alias for older config callers. Prefer DEFAULT_ALLOWED_REPO_PATTERN. */
export const DEFAULT_ALLOWED_OWNER_PATTERN = "^roshangautam$";

export type PaperclipAgentOption = {
  id: string;
  name: string;
  role?: string | null;
  title?: string | null;
  status?: string | null;
};

export type PaperclipAgentsData = {
  agents: PaperclipAgentOption[];
};

export type GitHubAppManifestFlowState = {
  agentId: string;
  state: string;
  manifest: string;
  postUrl: string;
  setupUrl: string;
  createdAt: string;
  label: string;
  appName: string;
  conversion?: ConvertGitHubAppManifestResult;
};

export type CreateGitHubAppManifestInput = {
  agentId: string;
  label: string;
  homepageUrl?: string;
  callbackUrl?: string;
  /** Compatibility alias for older callers. Prefer callbackUrl. */
  appUrl?: string;
};

export type CreateGitHubAppManifestResult = GitHubAppManifestFlowState & {
  appName: string;
};

export type GetGitHubAppManifestFlowInput = {
  state: string;
};

export type GetGitHubAppManifestFlowResult = CreateGitHubAppManifestResult;

export type ConvertGitHubAppManifestInput = {
  state: string;
  code: string;
};

export type ConvertGitHubAppManifestResult = {
  agentId: string;
  appId: string;
  appSlug: string;
  appName: string;
  githubUsername: string;
  privateKeyFile: string;
  installUrl: string;
};

export const DEFAULT_BOT_IDENTITY_CONFIG: BotIdentityConfig = {
  agentId: "",
  label: "",
  githubUsername: "",
  allowedRepoPatterns: [...DEFAULT_ALLOWED_REPO_PATTERNS],
  githubAppCredentialPropagationAgentIds: [],
  commitName: "",
  commitEmail: "",
};

/**
 * Validate that a repository string matches configured owner/repo glob patterns.
 * Returns an error message if invalid, or null if valid.
 */
export function validateRepoPolicy(
  repository: string,
  allowedPatterns: readonly string[] = DEFAULT_ALLOWED_REPO_PATTERNS,
): string | null {
  if (!repository || typeof repository !== "string") {
    return "repository is required and must be a non-empty string";
  }
  const parts = repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return `repository must be in "owner/repo" format, got "${repository}"`;
  }
  if (allowedPatterns.length === 0) {
    return "no allowed repository patterns configured";
  }
  for (const pattern of allowedPatterns) {
    const regex = repoPatternToRegExp(pattern);
    if (regex instanceof Error) {
      return regex.message;
    }
    if (regex.test(repository.toLowerCase())) {
      return null;
    }
  }
  return `repository "${repository}" does not match allowed repository patterns`;
}

function repoPatternToRegExp(pattern: string): RegExp | Error {
  const normalized = pattern.trim().toLowerCase();
  const parts = normalized.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return new Error(`allowed repository pattern must be in "owner/repo" format, got "${pattern}"`);
  }
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const globbed = escaped.replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${globbed}$`);
}
