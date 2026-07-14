// Shared manifest metadata for the two Slack reaction tools (DRO-974 /
// upstream issue #61). Mirrors `github-bot-push-branch-tool-definition.ts`'s
// shape: a plain metadata object plus a manifest-tool fragment, consumed by
// both the tool spec (`src/providers/slack/tools/react.ts`) and
// `src/providers/slack/manifest-tools.ts`.
//
// Both `slack_bot_add_reaction` and `slack_bot_remove_reaction` share the
// exact same parameter schema per openwiki/domain/slack-provider-design.md
// §6.1 — only the tool name/description/registered action differ.

const channelIdProperty = {
  type: "string",
  pattern: "^[CG][A-Z0-9]{8,}$"
} as const;

const teamIdProperty = {
  type: "string",
  pattern: "^T[A-Z0-9]{8,}$"
} as const;

const messageTsProperty = {
  type: "string",
  pattern: "^[0-9]{10,}\\.[0-9]{6}$"
} as const;

const reactionProperty = {
  type: "string",
  minLength: 1,
  maxLength: 100,
  pattern: "^[a-z0-9_+-]+$"
} as const;

export const slackReactionParametersSchema = {
  type: "object",
  properties: {
    channelId: channelIdProperty,
    // Optional cross-workspace-ambiguity guard, not a way to select a
    // different workspace — mirrors SlackChannelRefParams.teamId
    // (../providers/slack/channel-ref.ts). When provided it must match the
    // resolved identity's own teamId; a mismatch fails resource-ref
    // resolution before any credential is resolved.
    teamId: teamIdProperty,
    messageTs: messageTsProperty,
    reaction: reactionProperty
  },
  required: ["messageTs", "reaction"],
  additionalProperties: false
} as const;

export const SLACK_BOT_ADD_REACTION_TOOL_NAME = "slack_bot_add_reaction";
export const SLACK_BOT_REMOVE_REACTION_TOOL_NAME = "slack_bot_remove_reaction";

export const slackBotAddReactionToolMetadata = {
  displayName: "Slack Add Reaction",
  description:
    "Adds an emoji reaction to a Slack message using the configured agent identity. " +
    "Requires only reactions:write. Duplicate calls with the same emoji on the same " +
    "message are caller-idempotent (Slack's already_reacted is treated as success).",
  parametersSchema: slackReactionParametersSchema
} as const;

export const slackBotRemoveReactionToolMetadata = {
  displayName: "Slack Remove Reaction",
  description:
    "Removes an emoji reaction previously added by the configured agent identity from a " +
    "Slack message. Requires only reactions:write. Slack's reactions.remove can only " +
    "remove a reaction the calling bot itself added — it cannot remove a reaction added " +
    "by a different user or bot. This call fails closed (returns an error, does not " +
    "report success) both when the reaction is already absent and when it belongs to a " +
    "different user/bot, since Slack's API cannot distinguish the two cases from the " +
    "single 'no_reaction' response.",
  parametersSchema: slackReactionParametersSchema
} as const;

export const slackBotAddReactionManifestTool = {
  name: SLACK_BOT_ADD_REACTION_TOOL_NAME,
  ...slackBotAddReactionToolMetadata
} as const;

export const slackBotRemoveReactionManifestTool = {
  name: SLACK_BOT_REMOVE_REACTION_TOOL_NAME,
  ...slackBotRemoveReactionToolMetadata
} as const;
