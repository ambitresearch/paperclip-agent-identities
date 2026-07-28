import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { createProviderRegistry } from "./providers/index.js";
import {
  REBIND_LEGACY_SLACK_CREDENTIALS_ACTION,
  RETRY_LEGACY_SLACK_SIDECAR_CLEANUP_ACTION,
} from "./shared/types.js";
import { EVENTS_REQUEST_URL_PATTERN } from "./shared/events-request-url.js";
import { AGENT_IDENTITIES_PLUGIN_ID } from "./shared/webhook-endpoints.js";

const registry = createProviderRegistry();

const slackSecretRefConfigSchema = {
  type: "string",
  format: "secret-ref",
} as const;

const slackIdentityConfigProperties = {
  label: { type: "string" },
  teamId: { type: "string" },
  appId: { type: "string" },
  botUserId: { type: "string" },
  defaultChannel: { type: "string" },
  // Any HTTPS URL without whitespace, a query, a fragment, or embedded
  // credentials. The production value is the host-mounted webhook route
  // (/api/companies/<companyId>/plugins/<pluginId>/webhooks/slack-events),
  // which the Settings UI derives automatically; a dev tunnel URL such as
  // https://<tunnel>/events is an equally valid manual override. This value is
  // embedded verbatim in the generated Slack app manifest, hence the strict
  // envelope. The authority run additionally excludes "@" so userinfo
  // (https://user:pass@host/...) cannot slip through -- `format: uri` alone
  // accepts it -- while "@" stays legal later in the path. The pattern itself
  // lives in src/shared/events-request-url.ts, shared with
  // normalizeEventsRequestUrl in src/providers/slack/app-manifest.ts so the two
  // validators cannot drift apart.
  eventsRequestUrl: {
    type: "string",
    // No `format: "uri"`. The pattern is the complete contract on both paths --
    // see src/shared/events-request-url.ts. Adding a second check here would
    // reintroduce the drift against the runtime gate that this replaced.
    pattern: EVENTS_REQUEST_URL_PATTERN,
  },
  credentials: {
    type: "object",
    properties: {
      botToken: slackSecretRefConfigSchema,
      signingSecret: slackSecretRefConfigSchema,
    },
    anyOf: [
      { maxProperties: 0 },
      { required: ["botToken", "signingSecret"] },
    ],
    additionalProperties: false,
  },
} as const;

const legacySlackMetadataRequired = ["label", "teamId", "appId", "botUserId"] as const;

const slackIdentityConfigSchema = {
  type: "object",
  properties: slackIdentityConfigProperties,
  // New writes contain credentials only. Public Slack install metadata lives
  // in plugin state; the optional scalar fields remain readable for the
  // full nested shape written by earlier releases.
  anyOf: [
    { required: ["credentials"] },
    { required: legacySlackMetadataRequired },
  ],
  additionalProperties: false,
} as const;

const agentIdentityConfigSchema = {
  type: "object",
  properties: {
    // Flat Slack fields remain schema-compatible with earlier builds of this
    // PR. Their credential refs are updated in place; public scalars are ignored.
    ...slackIdentityConfigProperties,
    githubUsername: { type: "string" },
    commitName: { type: "string" },
    commitEmail: { type: "string" },
    slack: slackIdentityConfigSchema,
  },
  anyOf: [
    { maxProperties: 0 },
    { required: ["label", "githubUsername"] },
    { required: legacySlackMetadataRequired },
    { required: ["slack"] },
  ],
  // A record is either the legacy flat Slack shape or the current provider
  // container. Keeping secret-ref fields in direct properties is required by
  // Paperclip so config.patchSecretRefs can determine one binding path.
  not: {
    anyOf: [
      { required: ["githubUsername", "teamId"] },
      { required: ["githubUsername", "appId"] },
      { required: ["githubUsername", "botUserId"] },
      { required: ["githubUsername", "defaultChannel"] },
      { required: ["githubUsername", "eventsRequestUrl"] },
      { required: ["githubUsername", "credentials"] },
      { required: ["slack", "teamId"] },
      { required: ["slack", "appId"] },
      { required: ["slack", "botUserId"] },
      { required: ["slack", "defaultChannel"] },
      { required: ["slack", "eventsRequestUrl"] },
      { required: ["slack", "credentials"] },
      { required: ["teamId", "commitName"] },
      { required: ["teamId", "commitEmail"] },
    ],
  },
  additionalProperties: false,
} as const;

// Worker actions are registered dynamically through `ctx.actions`; the
// current manifest schema has no action-declaration field. Keep the public
// action keys here so UI wiring/tests share one explicit contract.
export const SETTINGS_ACTIONS = [
  "save-bot-identity-config",
  "delete-bot-identity-config",
  "create-github-app-manifest",
  "get-github-app-manifest-flow",
  "convert-github-app-manifest",
  "create-slack-app-manifest",
  "get-slack-app-manifest-flow",
  "discover-slack-install-metadata",
  "save-slack-install-metadata",
  REBIND_LEGACY_SLACK_CREDENTIALS_ACTION,
  RETRY_LEGACY_SLACK_SIDECAR_CLEANUP_ACTION,
] as const;

const manifest: PaperclipPluginManifestV1 = {
  // Shared with the webhook route builder: the host mounts this plugin's
  // webhooks under its manifest id, so a literal here would silently break
  // every derived Slack Events URL if the id ever changed.
  id: AGENT_IDENTITIES_PLUGIN_ID,
  apiVersion: 1,
  version: "0.2.9",
  displayName: "Agent Identities",
  description: "Per-agent identity providers and contribution tools for Paperclip",
  author: "Roshan Gautam",
  categories: ["connector"],
  instanceConfigSchema: {
    type: "object",
    properties: {
      identities: {
        type: "object",
        patternProperties: {
          "^.+$": agentIdentityConfigSchema,
        },
        additionalProperties: false,
      },
      setup: {
        type: "object",
        properties: {
          slack: {
            type: "object",
            properties: {
              metadata: {
                type: "object",
                patternProperties: {
                  "^[0-9a-f]{32}$": {
                    type: "object",
                    properties: {
                      botToken: slackSecretRefConfigSchema,
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false
  },
  capabilities: [
    "events.subscribe",
    // Slack webhook scope persists a turn, then awaits a company-scoped
    // provider self-event instead of invoking an agent session inline.
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
    "instance.settings.register",
    "project.workspaces.read",
    "execution.workspaces.read",
    "issues.read",
    "agent.tools.register",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "companies.read",
    // Required by github_bot_get_issue_interaction_summary, which reads a
    // Paperclip issue and its comments only -- it never calls GitHub.
    "issues.read",
    "issue.comments.read",
    "http.outbound",
    // The local host supports this capability ahead of the published SDK type union.
    "secrets.bind-ref" as PaperclipPluginManifestV1["capabilities"][number],
    "secrets.read-ref",
    "activity.log.write",
    "webhooks.receive"
  ],
  // Webhook endpoints contributed by any registered provider (e.g. Slack's
  // HTTP Events API ingress, DRO-975), composed generically via
  // `ProviderRegistry.webhooks()` -- no provider-specific branch here. See
  // `IdentityProvider.webhooks`/`handleWebhook` in
  // src/core/provider-contract.ts and src/providers/slack/ingress/ for the
  // concrete Slack implementation this seam currently carries.
  webhooks: registry.webhooks().map(({ declaration }) => ({
    endpointKey: declaration.endpointKey,
    displayName: declaration.displayName,
    ...(declaration.description ? { description: declaration.description } : {})
  })) as PaperclipPluginManifestV1["webhooks"],
  // Advertise a manifest fragment for exactly the tools that are actually
  // live (see `liveTools()` on the registry): every tool from a
  // `toolsEnabled()` provider (tool surface live, independent of the
  // provider's settings-UI `status` -- e.g. Slack's slack_bot_post_message,
  // DRO-973), plus any individual tool a not-yet-enabled provider marks
  // `live: true` (e.g. Slack's credential-free whoami self-check, DRO-972).
  // Matched to `manifestTools` fragments generically by name -- no
  // provider-specific branch here.
  tools: (() => {
    const liveNames = new Set(registry.liveTools().map(({ tool }) => tool.name));
    return registry
      .all()
      .flatMap((provider) => provider.manifestTools as ReadonlyArray<{ name: string }>)
      .filter((manifestTool) => liveNames.has(manifestTool.name));
  })() as PaperclipPluginManifestV1["tools"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Agent Identity Coverage",
        exportName: "DashboardWidget"
      },
      {
        type: "settingsPage",
        id: "bot-identity-settings",
        displayName: "Agent Identities Settings",
        exportName: "SettingsPage"
      }
    ]
  }
};

export default manifest;
