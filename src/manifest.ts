import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { createProviderRegistry } from "./providers/index.js";
import {
  REBIND_LEGACY_SLACK_CREDENTIALS_ACTION,
  RETRY_LEGACY_SLACK_SIDECAR_CLEANUP_ACTION,
} from "./shared/types.js";

const registry = createProviderRegistry();

const slackSecretRefConfigSchema = {
  type: "object",
  properties: {
    type: { const: "secret_ref" },
    secretId: { type: "string", format: "uuid" },
    version: { const: "latest" },
  },
  required: ["type", "secretId", "version"],
  additionalProperties: false,
} as const;

const slackIdentityConfigSchema = {
  type: "object",
  properties: {
    label: { type: "string" },
    teamId: { type: "string" },
    appId: { type: "string" },
    botUserId: { type: "string" },
    defaultChannel: { type: "string" },
    eventsRequestUrl: { type: "string", format: "uri", pattern: "^https://.+/events$" },
    credentials: {
      type: "object",
      properties: {
        botToken: slackSecretRefConfigSchema,
        signingSecret: slackSecretRefConfigSchema,
      },
      required: ["botToken", "signingSecret"],
      additionalProperties: false,
    },
  },
  required: ["label", "teamId", "appId", "botUserId", "credentials"],
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
  id: "ambitresearch.paperclip-agent-identities",
  apiVersion: 1,
  version: "0.2.3",
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
          "^.+$": {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
              },
              // Compatibility for flat Slack records persisted by earlier
              // builds of this PR. All new writes migrate to `.slack`.
              slackIdentityConfigSchema,
              {
                type: "object",
                properties: {
                  label: { type: "string" },
                  githubUsername: { type: "string" },
                  commitName: { type: "string" },
                  commitEmail: { type: "string" },
                  slack: slackIdentityConfigSchema,
                },
                anyOf: [
                  { required: ["label", "githubUsername"] },
                  { required: ["slack"] },
                ],
                additionalProperties: false,
              },
            ],
          },
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
                    required: ["botToken"],
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
    "agent.tools.register",
    "agents.read",
    "agent.sessions.create",
    "agent.sessions.list",
    "agent.sessions.send",
    "agent.sessions.close",
    "companies.read",
    "http.outbound",
    "secrets.bind-ref",
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
