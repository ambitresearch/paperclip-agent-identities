import { createSign } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "./identity-policy.js";

export const CREDENTIAL_SIDECAR_PATH_ENV = "PAPERCLIP_AGENT_IDENTITIES_CREDENTIALS";
export const LEGACY_CREDENTIAL_SIDECAR_PATH_ENV = "PAPERCLIP_GITHUB_BOT_IDENTITY_CREDENTIALS";
export const DEFAULT_CREDENTIAL_SIDECAR_PATH = "/paperclip/.paperclip/agent-identities/credentials.json";

const githubAppCredentialSchema = z.object({
  appId: z.string().trim().min(1),
  installationId: z.string().trim().min(1),
  privateKeySecretId: z.string().trim().uuid().optional(),
  privateKeyFile: z.string().trim().min(1).optional(),
}).refine((value) => Boolean(value.privateKeySecretId || value.privateKeyFile), {
  message: "Expected either privateKeySecretId or privateKeyFile for GitHub App credentials"
});

const sidecarIdentitySchema = z.object({
  secretId: z.string().trim().uuid().optional(),
  tokenFile: z.string().trim().min(1).optional(),
  githubApp: githubAppCredentialSchema.optional(),
}).refine((value) => Boolean(value.githubApp || value.secretId || value.tokenFile), {
  message: "Expected githubApp, secretId, or tokenFile"
});

const credentialSidecarSchema = z.object({
  version: z.literal(1).default(1),
  identities: z.record(z.string().trim().min(1), sidecarIdentitySchema)
});

export type GitHubBotIdentityCredentialSidecar = z.infer<typeof credentialSidecarSchema>;
export type GitHubAppCredentialConfig = z.infer<typeof githubAppCredentialSchema>;
export type ResolveSecret = (secretRef: string) => Promise<string>;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type CredentialSidecarIdentity = z.infer<typeof sidecarIdentitySchema>;

export interface ResolvedIdentityToken {
  token: string;
  source: "plugin-secret" | "token-file" | "github-app";
}

export function getCredentialSidecarPath(): string {
  return (
    process.env[CREDENTIAL_SIDECAR_PATH_ENV]?.trim() ||
    process.env[LEGACY_CREDENTIAL_SIDECAR_PATH_ENV]?.trim() ||
    DEFAULT_CREDENTIAL_SIDECAR_PATH
  );
}

export function parseCredentialSidecar(rawConfig: unknown): GitHubBotIdentityCredentialSidecar {
  return credentialSidecarSchema.parse(rawConfig);
}

export async function readCredentialSidecar(path = getCredentialSidecarPath()): Promise<GitHubBotIdentityCredentialSidecar> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read agent identity credential sidecar at '${path}': ${message}`);
  }

  try {
    return parseCredentialSidecar(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid agent identity credential sidecar at '${path}': ${message}`);
  }
}

export async function readCredentialSidecarIfExists(
  path = getCredentialSidecarPath()
): Promise<GitHubBotIdentityCredentialSidecar | null> {
  try {
    return await readCredentialSidecar(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("ENOENT")) {
      return null;
    }
    throw error;
  }
}

export async function upsertCredentialSidecarIdentity(
  agentId: string,
  identity: CredentialSidecarIdentity,
  path = getCredentialSidecarPath()
): Promise<GitHubBotIdentityCredentialSidecar> {
  const parsedIdentity = sidecarIdentitySchema.parse(identity);
  const existing = await readCredentialSidecarIfExists(path) ?? { version: 1 as const, identities: {} };
  const next: GitHubBotIdentityCredentialSidecar = {
    version: 1,
    identities: {
      ...existing.identities,
      [agentId]: parsedIdentity,
    },
  };
  await writeCredentialSidecar(next, path);
  return next;
}

export async function deleteCredentialSidecarIdentity(
  agentId: string,
  path = getCredentialSidecarPath()
): Promise<GitHubBotIdentityCredentialSidecar | null> {
  const existing = await readCredentialSidecarIfExists(path);
  if (!existing || !existing.identities[agentId]) {
    return existing;
  }

  const { [agentId]: _removed, ...identities } = existing.identities;
  const next: GitHubBotIdentityCredentialSidecar = { version: 1, identities };
  await writeCredentialSidecar(next, path);
  return next;
}

async function writeCredentialSidecar(
  sidecar: GitHubBotIdentityCredentialSidecar,
  path: string
): Promise<void> {
  const parsed = parseCredentialSidecar(sidecar);
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, path);
}

export async function resolveIdentitySecretRef(resolvedIdentity: ResolvedAgentIdentity): Promise<string> {
  const inlineSecretRef = resolvedIdentity.identity.tokenSecretRef?.trim();
  if (inlineSecretRef) {
    return inlineSecretRef;
  }

  const sidecarPath = getCredentialSidecarPath();
  const sidecarIdentity = await readSidecarIdentity(resolvedIdentity, sidecarPath);
  if (!sidecarIdentity.secretId) {
    throw new Error(
      `Missing GitHub bot credential secretId for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId}.secretId in ${sidecarPath}.`
    );
  }

  return sidecarIdentity.secretId;
}

export async function resolveIdentityToken(
  resolvedIdentity: ResolvedAgentIdentity,
  resolveSecret: ResolveSecret,
  fetchImpl: FetchLike = fetch
): Promise<ResolvedIdentityToken> {
  const inlineSecretRef = resolvedIdentity.identity.tokenSecretRef?.trim();
  if (inlineSecretRef) {
    return { token: await resolveSecret(inlineSecretRef), source: "plugin-secret" };
  }

  const sidecarPath = getCredentialSidecarPath();
  const sidecarIdentity = await readSidecarIdentity(resolvedIdentity, sidecarPath);
  if (sidecarIdentity.githubApp) {
    return {
      token: await mintGitHubAppInstallationToken(sidecarIdentity.githubApp, resolveSecret, fetchImpl),
      source: "github-app",
    };
  }

  if (sidecarIdentity.secretId) {
    try {
      return { token: await resolveSecret(sidecarIdentity.secretId), source: "plugin-secret" };
    } catch {
      if (!sidecarIdentity.tokenFile) {
        throw new Error("Failed to resolve bot authentication credentials.");
      }
    }
  }

  if (!sidecarIdentity.tokenFile) {
    throw new Error(
      `Missing GitHub bot credential tokenFile for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId}.tokenFile in ${sidecarPath}.`
    );
  }

  return { token: await readTokenFile(sidecarIdentity.tokenFile), source: "token-file" };
}

async function readSidecarIdentity(resolvedIdentity: ResolvedAgentIdentity, sidecarPath: string) {
  const sidecar = await readCredentialSidecar(sidecarPath);
  const sidecarIdentity = sidecar.identities[resolvedIdentity.agentId];
  if (!sidecarIdentity) {
    throw new Error(
      `Missing agent identity credential sidecar entry for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId} in ${sidecarPath}.`
    );
  }
  return sidecarIdentity;
}

async function mintGitHubAppInstallationToken(
  config: GitHubAppCredentialConfig,
  resolveSecret: ResolveSecret,
  fetchImpl: FetchLike
): Promise<string> {
  const privateKey = await resolveGitHubAppPrivateKey(config, resolveSecret);
  const jwt = createGitHubAppJwt(config.appId, privateKey);
  const response = await fetchImpl(`https://api.github.com/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "paperclip-agent-identities/github-app-token-mint",
    },
  });
  const body = await response.json().catch(() => ({})) as { token?: unknown; message?: unknown };
  if (!response.ok || typeof body.token !== "string" || !body.token.trim()) {
    const message = typeof body.message === "string" ? body.message : response.statusText;
    throw new Error(`GitHub App token exchange failed: ${response.status} ${message}`);
  }
  return body.token.trim();
}

async function resolveGitHubAppPrivateKey(
  config: GitHubAppCredentialConfig,
  resolveSecret: ResolveSecret
): Promise<string> {
  if (config.privateKeySecretId) {
    try {
      return normalizePrivateKey(await resolveSecret(config.privateKeySecretId));
    } catch {
      if (!config.privateKeyFile) {
        throw new Error("Failed to resolve GitHub App private key secret.");
      }
    }
  }

  if (!config.privateKeyFile) {
    throw new Error("Missing GitHub App private key source.");
  }
  return normalizePrivateKey(await readPrivateKeyFile(config.privateKeyFile));
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 60, exp: now + 9 * 60, iss: appId };
  const signingInput = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey, "base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

function base64Url(input: string): string {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function readPrivateKeyFile(privateKeyFile: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(privateKeyFile, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read GitHub App private key file '${privateKeyFile}': ${message}`);
  }
  return raw;
}

async function readTokenFile(tokenFile: string): Promise<string> {
  let raw: string;
  try {
    raw = await readFile(tokenFile, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read GitHub bot token file '${tokenFile}': ${message}`);
  }

  const token = raw.trim();
  if (!token) {
    throw new Error(`GitHub bot token file '${tokenFile}' is empty`);
  }
  return token;
}

function normalizePrivateKey(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("GitHub App private key is empty");
  }
  return trimmed.replace(/\\n/g, "\n");
}
