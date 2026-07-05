import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  githubBotPushBranchToolDefinition
} from "./github-bot-push-branch-tool-definition.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "roshangautam.paperclip-github-bot-identity",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Bot Identity",
  description: "Per-agent GitHub bot identity and contribution tools for Paperclip",
  author: "Roshan Gautam",
  categories: ["connector"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
    "instance.settings.register",
    "project.workspaces.read",
    "agent.tools.register",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "GitHub Bot Identity Health",
        exportName: "DashboardWidget"
      },
      {
        type: "settingsPage",
        id: "bot-identity-settings",
        displayName: "Bot Identity Settings",
        exportName: "SettingsPage"
      }
    ]
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    required: ["identities"],
    properties: {
      identities: {
        type: "object",
        minProperties: 1,
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          required: ["label", "githubUsername", "tokenSecretRef"],
          properties: {
            label: { type: "string", minLength: 1 },
            githubUsername: { type: "string", minLength: 1 },
            tokenSecretRef: { type: "string", minLength: 1 },
            allowedOwnerPatterns: {
              type: "array",
              items: { type: "string", minLength: 1 }
            },
            allowedRepos: {
              type: "array",
              items: { type: "string", minLength: 1 }
            },
            commitName: { type: "string", minLength: 1 },
            commitEmail: { type: "string", minLength: 1 }
          }
        }
      }
    }
  },
  tools: [
    {
      name: GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
      ...githubBotPushBranchToolDefinition
    }
  ]
};

export default manifest;
