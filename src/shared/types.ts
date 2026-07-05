/**
 * Shared types and config defaults for the GitHub Bot Identity plugin.
 */

export interface BotIdentityConfig {
  /** GitHub owner prefix for repository policy enforcement (e.g. "roshangautam"). */
  allowedOwner: string;
  /** Secret reference used to resolve the bot's GitHub token at call time. */
  tokenSecretRef: string;
}

export const DEFAULT_BOT_IDENTITY_CONFIG: BotIdentityConfig = {
  allowedOwner: "roshangautam",
  tokenSecretRef: "GITHUB_BOT_TOKEN",
};

/** Valid characters for an owner name (GitHub username format). */
const OWNER_NAME_FORMAT = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that a repository string matches the allowed owner policy.
 * Returns an error message if invalid, or null if valid.
 */
export function validateRepoPolicy(
  repository: string,
  allowedOwner: string,
): string | null {
  if (!repository || typeof repository !== "string") {
    return "repository is required and must be a non-empty string";
  }
  if (!OWNER_NAME_FORMAT.test(allowedOwner)) {
    return `allowedOwner "${allowedOwner}" contains invalid characters`;
  }
  const parts = repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return `repository must be in "owner/repo" format, got "${repository}"`;
  }
  if (parts[0] !== allowedOwner) {
    return `repository owner must be "${allowedOwner}", got "${parts[0]}"`;
  }
  return null;
}
