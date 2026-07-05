import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { githubBotWhoamiManifestTool } from "./shared/github-bot-whoami-tool.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "roshangautam.paperclip-github-bot-identity",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "GitHub Bot Identity",
  description: "Per-agent GitHub bot identity and contribution tools for Paperclip",
  author: "Roshan Gautam",
  categories: ["connector"],
  instanceConfigSchema: {
    type: "object",
    properties: {
      identities: {
        type: "object",
        patternProperties: {
          "^.+$": {
            type: "object",
            properties: {
              label: { type: "string" },
              githubUsername: { type: "string" },
              tokenSecretRef: { type: "string" },
              allowedOwnerPatterns: {
                type: "array",
                items: { type: "string" }
              },
              allowedRepos: {
                type: "array",
                items: { type: "string" }
              },
              commitName: { type: "string" },
              commitEmail: { type: "string" }
            },
            required: ["label", "githubUsername", "tokenSecretRef"],
            additionalProperties: false
          }
        }
      }
    },
    additionalProperties: false
  },
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register",
    "agent.tools.register",
    "instance.settings.register"
  ],
  tools: [githubBotWhoamiManifestTool],
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
  }
};

export default manifest;
