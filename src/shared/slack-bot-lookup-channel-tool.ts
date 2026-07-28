// Shared manifest metadata for `slack_bot_lookup_channel` (DRO-975 /
// DRO-1160). Mirrors `slack-bot-reaction-tool-definition.ts`'s shape: a plain
// metadata object plus a manifest-tool fragment, consumed by both the tool
// spec (`src/providers/slack/tools/lookup-channel.ts`) and
// `src/providers/slack/manifest-tools.ts`.
//
// This tool resolves a human-readable Slack channel name (e.g. "general" or
// "#general") to its canonical conversation ID via a credentialed
// `conversations.list` call, per the large comment block in
// `../providers/slack/channel-ref.ts` explaining why name -> ID lookup cannot
// happen in the credential-free `resolveSlackChannelRef` resource-ref step.

const teamIdProperty = {
  type: "string",
  pattern: "^T[A-Z0-9]{8,}$"
} as const;

export const slackLookupChannelParametersSchema = {
  type: "object",
  properties: {
    // Either a human-readable channel name ("general", "#general") or an
    // already-resolved conversation ID ("C0123456789"). When an ID is
    // provided it is validated and returned as-is, with no additional API
    // call — see lookup-channel.ts.
    channel: {
      type: "string",
      minLength: 1,
      maxLength: 80,
      // Slack's own channel-name grammar (lowercase, digits, '.', '_', '-',
      // optional leading '#') OR an already-resolved conversation ID.
      // URLs and arbitrary free text are rejected — see
      // `../providers/slack/tools/lookup-channel.ts`'s
      // `CHANNEL_NAME_PATTERN`/`CHANNEL_ID_PATTERN`.
      pattern: "^(#?[a-z0-9][a-z0-9._-]{0,79}|[CDG][A-Z0-9]{8,})$"
    },
    // Optional cross-workspace-ambiguity guard, not a way to select a
    // different workspace — mirrors SlackChannelRefParams.teamId
    // (../providers/slack/channel-ref.ts). When provided it must match the
    // resolved identity's own teamId; a mismatch fails before any credential
    // is resolved.
    teamId: teamIdProperty
  },
  required: ["channel"],
  additionalProperties: false
} as const;

export const SLACK_BOT_LOOKUP_CHANNEL_TOOL_NAME = "slack_bot_lookup_channel";

export const slackBotLookupChannelToolMetadata = {
  displayName: "Slack Lookup Channel",
  description:
    "Resolves a human-readable Slack channel name to its canonical conversation ID and " +
    "metadata using the configured agent identity. Requires channels:read (and " +
    "groups:read for private channels the bot is a member of). Only channels the bot " +
    "can already see via conversations.list are considered — this tool never joins a " +
    "channel on the caller's behalf. An already-resolved conversation ID may be passed " +
    "as `channel` instead of a name; it is validated and returned without an extra API " +
    "call. `channel` must match Slack's own channel-name grammar (lowercase letters, " +
    "digits, '.', '_', '-', optional leading '#', max 80 characters) or a resolved " +
    "conversation ID — URLs and free text are rejected. Ambiguous (duplicate) names " +
    "and channels with zero accessible matches both return an explicit, actionable " +
    "error rather than guessing; a workspace too large to fully scan also fails " +
    "closed instead of guessing at uniqueness.",
  parametersSchema: slackLookupChannelParametersSchema
} as const;

export const slackBotLookupChannelManifestTool = {
  name: SLACK_BOT_LOOKUP_CHANNEL_TOOL_NAME,
  ...slackBotLookupChannelToolMetadata
} as const;
