import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { createProviderRegistry } from "./providers/index.js";

const registry = createProviderRegistry();

const manifest: PaperclipPluginManifestV1 = {
  id: "roshangautam.paperclip-agent-identities",
  apiVersion: 1,
  version: "0.1.3",
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
            type: "object",
            properties: {
              label: { type: "string" },
              githubUsername: { type: "string" },
              commitName: { type: "string" },
              commitEmail: { type: "string" }
            },
            required: ["label", "githubUsername"],
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
    "instance.settings.register",
    "project.workspaces.read",
    "agent.tools.register",
    "agents.read",
    "companies.read",
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write"
  ],
  tools: registry.enabled().flatMap((provider) => provider.manifestTools) as PaperclipPluginManifestV1["tools"],
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
