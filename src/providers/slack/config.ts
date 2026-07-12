import { z } from "@paperclipai/plugin-sdk";
import type { SlackAgentIdentityConfig } from "../../core/identity-config.js";

// Public, shareable Slack identity metadata only. No credential field ever
// appears here — see openwiki/domain/slack-provider-mvp.md §1. The bot token
// and signing secret live exclusively in the credential sidecar
// (src/credential-sidecar.ts's `slackBotToken` source).
export const slackIdentitySchema = z.object({
  label: z.string().trim().min(1),
  teamId: z.string().trim().min(1),
  appId: z.string().trim().min(1),
  botUserId: z.string().trim().min(1),
  defaultChannel: z.string().trim().min(1).optional(),
});

export type SlackAgentIdentity = z.infer<typeof slackIdentitySchema>;

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
