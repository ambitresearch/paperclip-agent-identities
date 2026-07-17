import { z } from "@paperclipai/plugin-sdk";
import type { SlackAgentIdentityConfig } from "../../core/identity-config.js";

// Public Slack identity metadata. Company-scoped plugin config may also carry
// a `credentials` sibling whose values are host-validated secret references;
// validation deliberately projects only these public fields.
export const slackIdentitySchema = z.object({
  label: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
  appId: z.string().trim().min(1),
  botUserId: z.string().trim().min(1),
  defaultChannel: z.string().trim().min(1).optional(),
});

export type SlackAgentIdentity = z.infer<typeof slackIdentitySchema>;

export const slackSecretIdSchema = z.string().trim().uuid();

export const slackSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: slackSecretIdSchema,
  version: z.literal("latest"),
});

export type SlackSecretRef = z.infer<typeof slackSecretRefSchema>;
export type SlackCredentialKind = "botToken" | "signingSecret";

function assertSafeConfigSegment(agentId: string): void {
  if (!agentId || /[.\\/]/.test(agentId)) {
    throw new Error("Slack agentId cannot be represented as a safe config path segment.");
  }
}

export function slackIdentityConfigPath(agentId: string): string[] {
  assertSafeConfigSegment(agentId);
  return ["identities", agentId];
}

export function slackCredentialConfigPath(agentId: string, credential: SlackCredentialKind): string {
  return [...slackIdentityConfigPath(agentId), "credentials", credential].join(".");
}

export function createSlackSecretRef(secretId: string): SlackSecretRef {
  return slackSecretRefSchema.parse({ type: "secret_ref", secretId, version: "latest" });
}

export function readSlackSecretRef(
  config: Record<string, unknown>,
  agentId: string,
  credential: SlackCredentialKind,
): SlackSecretRef {
  const identities = isRecord(config.identities) ? config.identities : {};
  const identity = isRecord(identities[agentId]) ? identities[agentId] : {};
  const credentials = isRecord(identity.credentials) ? identity.credentials : {};
  const parsed = slackSecretRefSchema.safeParse(credentials[credential]);
  if (!parsed.success) {
    throw new Error(`Missing or invalid Slack ${credential} secret reference for agent '${agentId}'.`);
  }
  return parsed.data;
}

export function validateSlackConfig(raw: unknown): SlackAgentIdentity | string {
  const parsed = slackIdentitySchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");
  }
  return parsed.data;
}

function isSlackIdentityConfig(value: unknown): value is SlackAgentIdentityConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { provider?: unknown; slack?: unknown };
  return candidate.provider === "slack" && typeof candidate.slack === "object" && candidate.slack !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toSlackAgentIdentity(config: SlackAgentIdentityConfig): SlackAgentIdentity {
  const identity: SlackAgentIdentity = {
    label: config.label,
    teamId: config.slack.teamId,
    appId: config.slack.appId,
    botUserId: config.slack.botUserId,
  };
  if (config.slack.defaultChannel) identity.defaultChannel = config.slack.defaultChannel;
  return identity;
}

export function projectSlackPluginConfig(
  identities: Record<string, unknown>
): Record<string, SlackAgentIdentity> {
  const projected: Record<string, SlackAgentIdentity> = {};
  for (const entry of Object.values(identities)) {
    if (!isSlackIdentityConfig(entry)) continue;
    const validated = validateSlackConfig(toSlackAgentIdentity(entry));
    if (typeof validated !== "string") {
      projected[entry.agentId] = validated;
    }
  }
  return projected;
}
