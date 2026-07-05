import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

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
      agentIdentities: {
        type: "array",
        items: {
          type: "object",
          properties: {
            companyId: { type: "string" },
            agentId: { type: "string" },
            label: { type: "string" },
            githubUsername: { type: "string" },
            allowedOwners: {
              type: "array",
              items: { type: "string" }
            },
            allowedRepos: {
              type: "array",
              items: { type: "string" }
            },
            commitName: { type: "string" },
            commitEmail: { type: "string" },
            tokenSecretRef: { type: "string" }
          },
          required: ["companyId", "agentId", "label", "githubUsername", "allowedOwners", "allowedRepos"],
          additionalProperties: false
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
    "agent.tools.register"
  ],
  tools: [
    {
      name: "github_bot_whoami",
      displayName: "GitHub Bot Who Am I",
      description: "Returns the calling agent's configured GitHub bot identity metadata.",
      parametersSchema: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
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
      }
    ]
  }
};

export default manifest;
