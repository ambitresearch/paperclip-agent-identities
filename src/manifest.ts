import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  githubBotPushBranchToolDefinition
} from "./githubBotPushBranchToolDefinition.js";

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
    properties: {
      githubTokenSecretRef: {
        type: "string",
        minLength: 1,
        title: "GitHub token secret reference",
        description: "Secret reference resolved at runtime for mediated git push operations."
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
