export type IdentityProviderId = "github" | "slack" | "mattermost" | "entra" | "gcp" | "aws";

export type IdentityProviderStatus = "enabled" | "coming-soon";

export type IdentityProviderDefinition = {
  id: IdentityProviderId;
  name: string;
  description: string;
  status: IdentityProviderStatus;
};

export const GITHUB_IDENTITY_PROVIDER_ID = "github" satisfies IdentityProviderId;

export const SUPPORTED_IDENTITY_PROVIDERS: readonly IdentityProviderDefinition[] = [
  {
    id: "github",
    name: "GitHub",
    description: "GitHub App identity for repositories, pull requests, branch pushes, and commit attribution.",
    status: "enabled",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Workspace identity for Slack messages and app-mediated actions.",
    status: "coming-soon",
  },
  {
    id: "mattermost",
    name: "Mattermost",
    description: "Team identity for Mattermost posts and channel operations.",
    status: "coming-soon",
  },
  {
    id: "entra",
    name: "Microsoft Entra",
    description: "Cloud directory identity for Microsoft Graph and Azure-backed workflows.",
    status: "coming-soon",
  },
  {
    id: "gcp",
    name: "Google Cloud",
    description: "Service account identity for Google Cloud APIs.",
    status: "coming-soon",
  },
  {
    id: "aws",
    name: "AWS",
    description: "IAM-backed identity for AWS APIs.",
    status: "coming-soon",
  },
] as const;

export function isIdentityProviderId(value: string): value is IdentityProviderId {
  return SUPPORTED_IDENTITY_PROVIDERS.some((provider) => provider.id === value);
}

export function getIdentityProviderDefinition(providerId: IdentityProviderId): IdentityProviderDefinition {
  return SUPPORTED_IDENTITY_PROVIDERS.find((provider) => provider.id === providerId)!;
}

export function getIdentityKey(agentId: string, provider: IdentityProviderId): string {
  return `${agentId.trim()}:${provider}`;
}

export type AgentIdentityConfig = {
  id: string;
  agentId: string;
  provider: IdentityProviderId;
  label: string;
  githubUsername: string;
  githubAppCredentialPropagationAgentIds?: string[];
  commitName?: string;
  commitEmail?: string;
};

export type BotIdentityConfig = AgentIdentityConfig;

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

export type AgentIdentitySettingsState = {
  version: 3;
  identities: Record<string, AgentIdentityConfig>;
};

export type BotIdentitySettingsState = AgentIdentitySettingsState;

export type BotIdentitySettingsEntry = BotIdentityConfig & {
  credential?: BotIdentityCredentialConfig;
  credentialStatus: "configured" | "missing" | "sidecar-unavailable";
};

export type BotIdentitySettingsData = {
  version: 3;
  identities: BotIdentitySettingsEntry[];
  providers: readonly IdentityProviderDefinition[];
  companyName?: string;
  credentialSidecarPath: string;
  credentialSidecarError?: string;
};

export type SaveBotIdentityConfigInput = Omit<BotIdentityConfig, "id"> & {
  id?: string;
  credential?: BotIdentityCredentialConfig;
};

export type DeleteBotIdentityConfigInput = {
  agentId: string;
  provider: IdentityProviderId;
};

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
  provider: IdentityProviderId;
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
  provider?: IdentityProviderId;
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
  provider: IdentityProviderId;
  appId: string;
  appSlug: string;
  appName: string;
  githubUsername: string;
  privateKeyFile: string;
  installUrl: string;
};

export const DEFAULT_BOT_IDENTITY_CONFIG: BotIdentityConfig = {
  id: "",
  agentId: "",
  provider: GITHUB_IDENTITY_PROVIDER_ID,
  label: "",
  githubUsername: "",
  githubAppCredentialPropagationAgentIds: [],
  commitName: "",
  commitEmail: "",
};
