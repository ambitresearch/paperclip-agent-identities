import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { SlackAgentIdentity } from "../config.js";
import type { SlackChannelRef, SlackChannelRefParams } from "../channel-ref.js";
import { resolveSlackChannelRef } from "../channel-ref.js";

// Slack short-name emoji, e.g. "white_check_mark" or ":white_check_mark:".
// Slack's own `reactions.add` `name` param does not include colons; we accept
// either caller spelling and normalize to the bare form. Skin-tone modifiers
// (e.g. "+1::skin-tone-2") are intentionally out of MVP scope — not required
// by the acceptance criteria and add ambiguity to the pattern.
const EMOJI_NAME_PATTERN = /^[a-z0-9_+-]+$/;
const TIMESTAMP_PATTERN = /^\d{10}\.\d{6}$/;

export const SLACK_REACT_TOOL_NAME = "slack_react";

export const slackReactToolMetadata = {
  displayName: "React to Slack Message (Agent Identity)",
  description:
    "Adds an emoji reaction to a Slack message using the configured agent identity. " +
    "Lets an agent acknowledge work without posting a redundant message. " +
    "Requires only the 'reactions:write' bot scope.",
  parametersSchema: {
    type: "object",
    properties: {
      channel: {
        type: "string",
        description: "Resolved Slack conversation ID (e.g. 'C0123456789'), not a channel name or URL."
      },
      timestamp: {
        type: "string",
        description: "Slack message timestamp to react to, e.g. '1719000000.123456'."
      },
      emoji: {
        type: "string",
        description: "Emoji short-name to react with, e.g. 'white_check_mark' or ':white_check_mark:'."
      },
      teamId: {
        type: "string",
        description: "Optional Slack team ID; must match the configured identity's workspace if provided."
      }
    },
    required: ["channel", "timestamp", "emoji"]
  }
} as const;

export interface SlackReactParams {
  readonly channel: string;
  readonly timestamp: string;
  readonly emoji: string;
  readonly teamId?: string;
}

// Accepts ":name:" or bare "name" and normalizes to the bare form Slack's
// `reactions.add` API expects. Returns null on anything else (empty, spaces,
// mismatched colons, disallowed characters).
export function normalizeSlackEmojiName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(":") || trimmed.endsWith(":")) {
    if (!(trimmed.startsWith(":") && trimmed.endsWith(":") && trimmed.length > 2)) {
      return null;
    }
    trimmed = trimmed.slice(1, -1);
  }
  if (!trimmed) return null;
  if (!EMOJI_NAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export function normalizeSlackMessageTimestamp(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!TIMESTAMP_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function validateParams(raw: unknown): ParamsValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "params must be a non-null object" };
  }
  const allowedKeys = new Set(["channel", "timestamp", "emoji", "teamId"]);
  const p = raw as Record<string, unknown>;
  const extraKeys = Object.keys(p).filter((key) => !allowedKeys.has(key));
  if (extraKeys.length > 0) {
    return { ok: false, error: `Unsupported parameter(s): ${extraKeys.join(", ")}` };
  }

  const emoji = normalizeSlackEmojiName(p.emoji);
  if (!emoji) {
    return {
      ok: false,
      error: "Invalid emoji. Provide a valid short-name, e.g. 'white_check_mark' or ':white_check_mark:'."
    };
  }

  const timestamp = normalizeSlackMessageTimestamp(p.timestamp);
  if (!timestamp) {
    return {
      ok: false,
      error: "Invalid timestamp. Expected Slack's '<seconds>.<micros>' message timestamp format."
    };
  }

  if (p.channel === undefined || typeof p.channel !== "string") {
    return { ok: false, error: "channel is required" };
  }

  if (p.teamId !== undefined && typeof p.teamId !== "string") {
    return { ok: false, error: "teamId must be a string if provided" };
  }

  const validated: SlackReactParams = {
    channel: p.channel,
    timestamp,
    emoji,
    teamId: p.teamId as string | undefined
  };
  return { ok: true, params: validated };
}

interface SlackReactionsAddErrorBody {
  ok?: unknown;
  error?: unknown;
}

export const slackReactToolSpec: ProviderToolSpec<SlackAgentIdentity, SlackChannelRef> = {
  name: SLACK_REACT_TOOL_NAME,
  metadata: slackReactToolMetadata,
  validateParams,
  async resolveResourceRef(
    input: ResourceRefResolverInput<SlackAgentIdentity>
  ): Promise<ResourceRefResolution<SlackChannelRef>> {
    const params = input.params as SlackReactParams;
    const refParams: SlackChannelRefParams = {
      channel: params.channel,
      threadTs: params.timestamp,
      teamId: params.teamId
    };
    return resolveSlackChannelRef(input, refParams);
  },
  async perform(
    execution: ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>
  ): Promise<unknown> {
    if (execution.token === null) {
      return { error: "Internal error: missing resolved credential." };
    }
    const token = execution.token;
    const ctx = execution.ctx;
    const runCtx = execution.runCtx;
    const validated = execution.params as SlackReactParams;
    const ref = execution.resourceRef as SlackChannelRef;

    let response: Response;
    try {
      response = await ctx.http.fetch("https://slack.com/api/reactions.add", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          channel: ref.channel,
          timestamp: validated.timestamp,
          name: validated.emoji
        })
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown network error";
      ctx.logger.error(`${SLACK_REACT_TOOL_NAME} network failure: ${reason}`);
      return { error: "Slack API request failed before a response was received." };
    }

    let body: SlackReactionsAddErrorBody;
    try {
      body = (await response.json()) as SlackReactionsAddErrorBody;
    } catch {
      return { error: `Slack API returned ${response.status} with an unparseable response body.` };
    }

    if (!response.ok || body.ok !== true) {
      const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
      return { error: `Slack reactions.add failed: ${code}`, code };
    }

    await ctx.activity.log({
      companyId: runCtx.companyId,
      message: `Added reaction ':${validated.emoji}:' to Slack message ${validated.timestamp} in ${ref.channel}`,
      entityType: "slack_reaction",
      entityId: `${ref.channel}:${validated.timestamp}`,
      metadata: {
        agentId: runCtx.agentId,
        channel: ref.channel,
        timestamp: validated.timestamp,
        emoji: validated.emoji
      }
    });
    ctx.logger.info(`${SLACK_REACT_TOOL_NAME}: reacted to ${ref.channel}:${validated.timestamp}`);

    return {
      content: `Added reaction :${validated.emoji}: to message ${validated.timestamp} in ${ref.channel}.`,
      data: {
        channel: ref.channel,
        timestamp: validated.timestamp,
        emoji: validated.emoji
      }
    };
  }
};
