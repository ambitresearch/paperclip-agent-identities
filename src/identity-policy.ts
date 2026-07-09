import { z, type ToolRunContext } from "@paperclipai/plugin-sdk";

const githubIdentitySchema = z.object({
  label: z.string().trim().min(1),
  githubUsername: z.string().trim().min(1),
  commitName: z.string().trim().min(1).optional(),
  commitEmail: z.string().trim().min(1).optional()
});

const pluginConfigSchema = z.object({
  identities: z.record(z.string().trim().min(1), githubIdentitySchema)
});

type ParsedGitHubAgentIdentity = z.infer<typeof githubIdentitySchema>;
type ParsedGitHubBotIdentityPluginConfig = z.infer<typeof pluginConfigSchema>;

export type GitHubAgentIdentity = ParsedGitHubAgentIdentity;

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

function normalizePluginConfig(config: ParsedGitHubBotIdentityPluginConfig): GitHubBotIdentityPluginConfig {
  const identities: Record<string, GitHubAgentIdentity> = {};
  for (const [agentId, identity] of Object.entries(config.identities)) {
    identities[agentId] = identity;
  }
  return { identities };
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
