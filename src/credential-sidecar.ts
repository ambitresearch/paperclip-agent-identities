import { readFile } from "node:fs/promises";
import { z } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "./identity-policy.js";

export const CREDENTIAL_SIDECAR_PATH_ENV = "PAPERCLIP_GITHUB_BOT_IDENTITY_CREDENTIALS";
export const DEFAULT_CREDENTIAL_SIDECAR_PATH = "/paperclip/.paperclip/github-bot-identity/credentials.json";

const sidecarIdentitySchema = z.object({
  secretId: z.string().trim().uuid().optional(),
  tokenFile: z.string().trim().min(1).optional()
}).refine((value) => Boolean(value.secretId || value.tokenFile), {
  message: "Expected either secretId or tokenFile"
});

const credentialSidecarSchema = z.object({
  version: z.literal(1).default(1),
  identities: z.record(z.string().trim().min(1), sidecarIdentitySchema)
});

export type GitHubBotIdentityCredentialSidecar = z.infer<typeof credentialSidecarSchema>;
export type ResolveSecret = (secretRef: string) => Promise<string>;

export interface ResolvedIdentityToken {
  token: string;
  source: "plugin-secret" | "token-file";
}

export function getCredentialSidecarPath(): string {
  return process.env[CREDENTIAL_SIDECAR_PATH_ENV]?.trim() || DEFAULT_CREDENTIAL_SIDECAR_PATH;
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
    throw new Error(`Unable to read GitHub bot credential sidecar at '${path}': ${message}`);
  }

  try {
    return parseCredentialSidecar(JSON.parse(raw));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid GitHub bot credential sidecar at '${path}': ${message}`);
  }
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
  resolveSecret: ResolveSecret
): Promise<ResolvedIdentityToken> {
  const inlineSecretRef = resolvedIdentity.identity.tokenSecretRef?.trim();
  if (inlineSecretRef) {
    return { token: await resolveSecret(inlineSecretRef), source: "plugin-secret" };
  }

  const sidecarPath = getCredentialSidecarPath();
  const sidecarIdentity = await readSidecarIdentity(resolvedIdentity, sidecarPath);
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
      `Missing GitHub bot credential sidecar entry for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId} in ${sidecarPath}.`
    );
  }
  return sidecarIdentity;
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
