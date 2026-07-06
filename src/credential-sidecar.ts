import { readFile } from "node:fs/promises";
import { z } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "./identity-policy.js";

export const CREDENTIAL_SIDECAR_PATH_ENV = "PAPERCLIP_GITHUB_BOT_IDENTITY_CREDENTIALS";
export const DEFAULT_CREDENTIAL_SIDECAR_PATH = "/paperclip/.paperclip/github-bot-identity/credentials.json";

const sidecarIdentitySchema = z.object({
  secretId: z.string().trim().uuid()
});

const credentialSidecarSchema = z.object({
  version: z.literal(1).default(1),
  identities: z.record(z.string().trim().min(1), sidecarIdentitySchema)
});

export type GitHubBotIdentityCredentialSidecar = z.infer<typeof credentialSidecarSchema>;

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
  const sidecar = await readCredentialSidecar(sidecarPath);
  const sidecarIdentity = sidecar.identities[resolvedIdentity.agentId];
  if (!sidecarIdentity) {
    throw new Error(
      `Missing GitHub bot credential sidecar entry for agent '${resolvedIdentity.agentId}'. ` +
      `Expected identities.${resolvedIdentity.agentId}.secretId in ${sidecarPath}.`
    );
  }

  return sidecarIdentity.secretId;
}
