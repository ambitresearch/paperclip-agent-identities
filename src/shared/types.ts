export type BotIdentityConfig = {
  agentId: string;
  label: string;
  githubUsername: string;
  tokenSecretRef: string;
  allowedOwnerPattern: string;
  commitName?: string;
  commitEmail?: string;
};

export const DEFAULT_ALLOWED_OWNER_PATTERN = "^roshangautam$";

export const DEFAULT_BOT_IDENTITY_CONFIG: BotIdentityConfig = {
  agentId: "",
  label: "",
  githubUsername: "",
  tokenSecretRef: "",
  allowedOwnerPattern: DEFAULT_ALLOWED_OWNER_PATTERN,
  commitName: "",
  commitEmail: "",
};
