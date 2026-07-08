import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
  githubBotPushBranchToolDefinition
} from "./github-bot-push-branch-tool-definition.js";
import { githubBotWhoamiManifestTool } from "./shared/github-bot-whoami-tool.js";
import { githubBotCreatePullRequestManifestTool } from "./shared/github-bot-create-pull-request-tool.js";

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
              allowedRepoPatterns: {
                type: "array",
                items: { type: "string" }
              },
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
    "http.outbound",
    "secrets.read-ref",
    "activity.log.write"
  ],
  tools: [
    githubBotWhoamiManifestTool,
    githubBotCreatePullRequestManifestTool,
    {
      name: GITHUB_BOT_PUSH_BRANCH_TOOL_NAME,
      ...githubBotPushBranchToolDefinition
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
