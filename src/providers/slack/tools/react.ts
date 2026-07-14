import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceRefResolution,
  ResourceRefResolverInput
} from "../../../core/provider-contract.js";
import type { SlackAgentIdentity } from "../config.js";
import { resolveSlackChannelRef, type SlackChannelRef } from "../channel-ref.js";
import {
  SLACK_BOT_ADD_REACTION_TOOL_NAME,
  SLACK_BOT_REMOVE_REACTION_TOOL_NAME,
  slackBotAddReactionToolMetadata,
  slackBotRemoveReactionToolMetadata
} from "../../../shared/slack-bot-reaction-tool-definition.js";

/**
 * Slack reaction tools (DRO-974 / upstream issue #61): `slack_bot_add_reaction`
 * and `slack_bot_remove_reaction`. Both share this one implementation module —
 * only the Slack API method, the `action` label on the result, and the tool
 * name/metadata differ, per openwiki/domain/slack-provider-design.md §6/§6.1.
 *
 * Mandatory pipeline order (validate params -> resolve identity -> resolve
 * resource ref -> resolve credentials -> perform -> redact) is enforced by
 * `createProviderTool` (src/core/tool-pipeline.ts); this module only
 * implements `validateParams`, `resolveResourceRef`, and `perform` for each
 * tool spec.
 */

export interface SlackReactionParams {
  readonly channelId?: string;
  readonly teamId?: string;
  readonly messageTs: string;
  readonly reaction: string;
}

// Mirrors slackReactionParametersSchema in
// ../../../shared/slack-bot-reaction-tool-definition.ts — kept in sync by
// hand since the manifest schema is a plain JSON Schema literal, not a zod
// schema this module can reuse directly.
const CHANNEL_ID_PATTERN = /^[CG][A-Z0-9]{8,}$/;
const TEAM_ID_PATTERN = /^T[A-Z0-9]{8,}$/;
const MESSAGE_TS_PATTERN = /^[0-9]{10,}\.[0-9]{6}$/;
const REACTION_PATTERN = /^[a-z0-9_+-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates raw tool params against the shared reaction schema, entirely
 * locally — no network call, no identity, no credential. This satisfies the
 * "validate emoji and timestamp locally" acceptance criterion: a malformed
 * emoji name or timestamp is rejected in step 1 of the pipeline, before
 * identity/resource-ref/credential resolution ever runs.
 */
function validateReactionParams(raw: unknown): ParamsValidation {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "params must be a non-null object" };
  }

  const { channelId, teamId, messageTs, reaction, ...rest } = raw;
  if (Object.keys(rest).length > 0) {
    return { ok: false, error: `Unknown parameter(s): ${Object.keys(rest).join(", ")}` };
  }

  if (channelId !== undefined) {
    if (typeof channelId !== "string" || !CHANNEL_ID_PATTERN.test(channelId.trim())) {
      return {
        ok: false,
        error: "Invalid channelId. Expected a resolved Slack conversation ID (e.g. 'C0123456789')."
      };
    }
  }

  if (teamId !== undefined) {
    if (typeof teamId !== "string" || !TEAM_ID_PATTERN.test(teamId.trim())) {
      return {
        ok: false,
        error: "Invalid teamId. Expected a Slack team ID (e.g. 'T0123456789')."
      };
    }
  }

  if (typeof messageTs !== "string" || !MESSAGE_TS_PATTERN.test(messageTs.trim())) {
    return {
      ok: false,
      error: "Invalid messageTs. Expected Slack's '<seconds>.<micros>' timestamp format."
    };
  }

  if (
    typeof reaction !== "string" ||
    reaction.trim().length > 100 ||
    !REACTION_PATTERN.test(reaction.trim())
  ) {
    return {
      ok: false,
      error:
        "Invalid reaction. Expected an emoji name without colons, 1-100 characters, matching ^[a-z0-9_+-]+$."
    };
  }

  const params: SlackReactionParams = {
    messageTs: messageTs.trim(),
    reaction: reaction.trim(),
    ...(channelId !== undefined ? { channelId: channelId.trim() } : {}),
    ...(teamId !== undefined ? { teamId: teamId.trim() } : {})
  };

  return { ok: true, params };
}

async function resolveReactionResourceRef(
  input: ResourceRefResolverInput<SlackAgentIdentity>
): Promise<ResourceRefResolution<SlackChannelRef>> {
  const params = input.params as SlackReactionParams;
  const channel = params.channelId ?? input.identity.identity.defaultChannel;
  if (!channel) {
    return {
      ok: false,
      error: "No channelId provided and no default channel configured for this identity."
    };
  }
  // `resolveSlackChannelRef` enforces the cross-workspace guard (wrong-team
  // references fail here, strictly before credential resolution) and emits
  // its own denial audit event — see ../channel-ref.ts.
  return resolveSlackChannelRef(input, { channel, teamId: params.teamId, threadTs: undefined });
}

type SlackReactionAction = "added" | "removed";

interface SlackReactionApiCallSpec {
  readonly method: string;
  // `null` means no Slack error code is treated as an idempotent no-op for
  // this call — every non-`ok` response fails closed. Only `reactions.add`'s
  // `already_reacted` is a genuine caller-idempotent duplicate. `no_reaction`
  // (reactions.remove) is deliberately NOT treated as idempotent success: it
  // is also returned when the reaction belongs to a different user/bot than
  // the caller (Slack's `reactions.remove` can only remove reactions the
  // calling bot itself added), so reporting `action: "removed"` in that case
  // would falsely claim a removal that never happened. Per
  // openwiki/domain/slack-provider-design.md §6, this must fail closed.
  readonly idempotentErrorCode: string | null;
  readonly action: SlackReactionAction;
}

const ADD_REACTION_SPEC: SlackReactionApiCallSpec = {
  method: "reactions.add",
  idempotentErrorCode: "already_reacted",
  action: "added"
};

const REMOVE_REACTION_SPEC: SlackReactionApiCallSpec = {
  method: "reactions.remove",
  idempotentErrorCode: null,
  action: "removed"
};

async function performReaction(
  execution: ProviderToolExecution<SlackAgentIdentity, SlackChannelRef>,
  spec: SlackReactionApiCallSpec
): Promise<unknown> {
  const ctx = execution.ctx;
  const runCtx = execution.runCtx;
  const ref = execution.resourceRef;
  const params = execution.params as SlackReactionParams;

  if (ref === null) {
    return { error: "Internal error: missing resolved Slack channel reference." };
  }
  if (execution.token === null) {
    return { error: "Internal error: missing resolved credential." };
  }
  const token = execution.token;

  let response: Response;
  try {
    response = await ctx.http.fetch(`https://slack.com/api/${spec.method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        channel: ref.channel,
        timestamp: params.messageTs,
        name: params.reaction
      })
    });
  } catch (error) {
    // Log only a non-secret classification, never the raw thrown message: an
    // HTTP adapter error can embed request details (headers/body), and the
    // bot token is already in the Authorization header by this point. See
    // Copilot finding on PR #79 — no-token-in-logs is a hard constraint.
    ctx.logger.error(`${spec.method} network failure: request could not complete`);
    return { error: "Slack API request failed before a response was received." };
  }

  const body = (await response.json().catch(() => ({}))) as { ok?: unknown; error?: unknown };

  // Caller-idempotent ONLY for `spec.idempotentErrorCode` (currently just
  // `reactions.add`'s `already_reacted`). `reactions.remove` has no
  // idempotent code — see the comment on `SlackReactionApiCallSpec` above —
  // so `no_reaction` falls through to the generic error path and fails
  // closed rather than reporting a false "removed".
  const isIdempotentNoOp =
    spec.idempotentErrorCode !== null && body.ok !== true && body.error === spec.idempotentErrorCode;

  if (body.ok !== true && !isIdempotentNoOp) {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    await ctx.activity.log({
      companyId: runCtx.companyId,
      entityType: "run",
      entityId: runCtx.runId,
      message: `${spec.method} failed`,
      metadata: {
        agentId: runCtx.agentId,
        runId: runCtx.runId,
        outcome: "slack_api_error",
        channel: ref.channel,
        reaction: params.reaction,
        slackError: reason
      }
    });
    return { error: `Slack API returned an error for ${spec.method}: ${reason}` };
  }

  await ctx.activity.log({
    companyId: runCtx.companyId,
    entityType: "run",
    entityId: runCtx.runId,
    message: `${spec.method} succeeded`,
    metadata: {
      agentId: runCtx.agentId,
      runId: runCtx.runId,
      outcome: isIdempotentNoOp ? "idempotent_no_op" : "success",
      channel: ref.channel,
      reaction: params.reaction
    }
  });

  return {
    content: `Reaction :${params.reaction}: ${spec.action} on ${ref.channel}:${params.messageTs}.`,
    data: {
      channelId: ref.channel,
      messageTs: params.messageTs,
      reaction: params.reaction,
      action: spec.action
    }
  };
}

export const slackAddReactionToolSpec: ProviderToolSpec<SlackAgentIdentity, SlackChannelRef> = {
  name: SLACK_BOT_ADD_REACTION_TOOL_NAME,
  metadata: slackBotAddReactionToolMetadata,
  validateParams: validateReactionParams,
  resolveResourceRef: resolveReactionResourceRef,
  async perform(execution) {
    return performReaction(execution, ADD_REACTION_SPEC);
  }
};

export const slackRemoveReactionToolSpec: ProviderToolSpec<SlackAgentIdentity, SlackChannelRef> = {
  name: SLACK_BOT_REMOVE_REACTION_TOOL_NAME,
  metadata: slackBotRemoveReactionToolMetadata,
  validateParams: validateReactionParams,
  resolveResourceRef: resolveReactionResourceRef,
  async perform(execution) {
    return performReaction(execution, REMOVE_REACTION_SPEC);
  }
};
