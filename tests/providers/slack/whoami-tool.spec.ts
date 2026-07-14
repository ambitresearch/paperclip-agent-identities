import { describe, it, expect } from "vitest";
import { slackWhoamiToolSpec } from "../../../src/providers/slack/tools/whoami.js";
import type {
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

  it("rejects unknown params via the manifest tool's parametersSchema", () => {
    const schema = slackWhoamiToolSpec.metadata as { parametersSchema: { additionalProperties: boolean } };
    expect(schema.parametersSchema.additionalProperties).toBe(false);
  });

  it("reports the configured identity without resolving a token", async () => {
    const execution = buildExecution({
      label: "Ops Bot",
      teamId: "T1234",
      appId: "A5678",
      botUserId: "U9999",
      defaultChannel: "C0001"
    });
    // `token: null` above proves credential resolution never ran for this
    // execution -- the shared pipeline only supplies a non-null token when
    // `requiresCredential` is true (or omitted).
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
    expect(result.content).toContain("Ops Bot");
    expect(result.content).toContain("T1234");
    expect(result.content).toContain("A5678");
    expect(result.content).toContain("U9999");
    expect(result.data).toEqual({
      label: "Ops Bot",
      teamId: "T1234",
      appId: "A5678",
      botUserId: "U9999",
      hasDefaultChannel: true
    });
  });

  it("reports a missing default channel as false", async () => {
    const execution = buildExecution({
      label: "Ops Bot",
      teamId: "T1234",
      appId: "A5678",
      botUserId: "U9999"
    });
    const result = (await slackWhoamiToolSpec.perform(execution)) as {
      data: { hasDefaultChannel: boolean };
    };
    expect(result.data.hasDefaultChannel).toBe(false);
  });
});
