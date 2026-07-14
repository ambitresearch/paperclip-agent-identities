import { describe, it, expect, vi } from "vitest";
import { slackWhoamiToolSpec } from "../../../src/providers/slack/tools/whoami.js";
import { createProviderTool } from "../../../src/core/tool-pipeline.js";
import type {
  IdentityProvider,
  ProviderToolExecution,
  ResourceReference
} from "../../../src/core/provider-contract.js";
import type { SlackAgentIdentity } from "../../../src/providers/slack/config.js";

function buildExecution(
  identity: SlackAgentIdentity
): ProviderToolExecution<SlackAgentIdentity, ResourceReference> {
  return {
    token: null,
    identity: { agentId: "agent-1", identity },
    resourceRef: null,
    params: {},
    ctx: {} as never,
    runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "proj-1", runId: "run-1" } as never
  };
}

describe("slackWhoamiToolSpec", () => {
  it("does not require a credential", () => {
    expect(slackWhoamiToolSpec.requiresCredential).toBe(false);
  });

  it("has no resolveResourceRef (identity-only tool)", () => {
    expect(slackWhoamiToolSpec.resolveResourceRef).toBeUndefined();
  });

  it("accepts empty params", () => {
    expect(slackWhoamiToolSpec.validateParams({})).toEqual({ ok: true, params: {} });
  });

  it("reports the configured identity without resolving a credential", async () => {
    const execution = buildExecution({
      label: "Kiln (CTO)",
      teamId: "T123",
      appId: "A456",
      botUserId: "U789",
      defaultChannel: "#general"
    });
    const result = (await slackWhoamiToolSpec.perform(execution)) as {
      content: string;
      data: {
        label: string;
        teamId: string;
        appId: string;
        botUserId: string;
        hasDefaultChannel: boolean;
      };
    };
    expect(result.content).toContain("Kiln (CTO)");
    expect(result.content).toContain("T123");
    expect(result.content).toContain("A456");
    expect(result.data).toEqual({
      label: "Kiln (CTO)",
      teamId: "T123",
      appId: "A456",
      botUserId: "U789",
      hasDefaultChannel: true
    });
  });

  it("reports a missing default channel as false", async () => {
    const execution = buildExecution({
      label: "Bot",
      teamId: "T000",
      appId: "A000",
      botUserId: "U000"
    });
    const result = (await slackWhoamiToolSpec.perform(execution)) as {
      data: { hasDefaultChannel: boolean };
    };
    expect(result.data.hasDefaultChannel).toBe(false);
  });

  it("never invokes credential resolution end-to-end through the tool pipeline", async () => {
    const resolveCredential = vi.fn(async () => {
      throw new Error("credential resolution must never be called for whoami");
    });
    const provider = {
      id: "slack",
      definition: { id: "slack", name: "Slack", status: "coming-soon", description: "" },
      validateConfig: () => ({}),
      projectPluginConfig: () => ({}),
      resolveCredential,
      tools: [slackWhoamiToolSpec],
      manifestTools: []
    } as unknown as IdentityProvider<SlackAgentIdentity, ResourceReference>;

    const deps = {
      resolveIdentity: async () => ({
        agentId: "agent-1",
        identity: {
          label: "Bot",
          teamId: "T000",
          appId: "A000",
          botUserId: "U000"
        }
      }),
      redactSecrets: <T,>(value: T): T => value
    };

    const tool = createProviderTool(
      provider,
      slackWhoamiToolSpec,
      { activity: { log: vi.fn().mockResolvedValue(undefined) }, logger: { error: vi.fn() } } as never,
      deps
    );

    const result = await tool.handler({}, { agentId: "agent-1" } as never);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect((result as { data: { teamId: string } }).data.teamId).toBe("T000");
  });

  it("fails closed through the shared pipeline when identity resolution fails (missing/malformed identity)", async () => {
    const provider = {
      id: "slack",
      definition: { id: "slack", name: "Slack", status: "coming-soon", description: "" },
      validateConfig: () => ({}),
      projectPluginConfig: () => ({}),
      resolveCredential: vi.fn(),
      tools: [slackWhoamiToolSpec],
      manifestTools: []
    } as unknown as IdentityProvider<SlackAgentIdentity, ResourceReference>;

    const deps = {
      resolveIdentity: async () => {
        throw new Error("no configured Slack identity for agent");
      },
      redactSecrets: <T,>(value: T): T => value
    };

    const tool = createProviderTool(
      provider,
      slackWhoamiToolSpec,
      { activity: { log: vi.fn().mockResolvedValue(undefined) }, logger: { error: vi.fn() } } as never,
      deps
    );

    const result = await tool.handler({}, { agentId: "agent-1" } as never);
    expect(result).toEqual({
      error: "slack_bot_whoami failed closed for agent 'agent-1': no configured Slack identity for agent"
    });
  });
});
