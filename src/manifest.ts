import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

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
    "instance.settings.register"
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
  }
};

export default manifest;
