import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { createProviderRegistry } from "./providers/index.js";

const registry = createProviderRegistry();

const manifest: PaperclipPluginManifestV1 = {
  id: "roshangautam.paperclip-agent-identities",
  apiVersion: 1,
  version: "0.1.8",
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
    "agents.invoke",
    "companies.read",
    "http.outbound",
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
  // live (see `liveTools()` on the registry): every tool from an "enabled"
  // provider, plus any individual tool a "coming-soon" provider marks
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
