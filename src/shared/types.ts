export type BotIdentityConfig = {
  agentId: string;
  label: string;
  githubUsername: string;
  allowedOwnerPattern: string;
  commitName?: string;
  commitEmail?: string;
};

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

export const DEFAULT_BOT_IDENTITY_CONFIG: BotIdentityConfig = {
  agentId: "",
  label: "",
  githubUsername: "",
  allowedOwnerPattern: DEFAULT_ALLOWED_OWNER_PATTERN,
  commitName: "",
  commitEmail: "",
};

/** Allowed owner for the create-pull-request tool's simple policy check. */
const TOOL_ALLOWED_OWNER = "roshangautam";

/** Valid characters for an owner name (GitHub username format). */
const OWNER_NAME_FORMAT = /^[a-zA-Z0-9_-]+$/;

/**
 * Validate that a repository string matches the allowed owner policy.
 * Returns an error message if invalid, or null if valid.
 */
export function validateRepoPolicy(
  repository: string,
  allowedOwner: string = TOOL_ALLOWED_OWNER,
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
