import { describe, it, expect } from "vitest";
import { githubWhoamiToolSpec } from "../../../src/providers/github/tools/whoami.js";
import type {
  ProviderToolExecution,
  ResourceReference
} from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

function buildExecution(
  identity: GitHubAgentIdentity
): ProviderToolExecution<GitHubAgentIdentity, ResourceReference> {
  return {
    token: null,
    identity: { agentId: "agent-1", identity },
    resourceRef: null,
    params: {},
    ctx: {} as never,
    runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "proj-1", runId: "run-1" } as never
  };
}

describe("githubWhoamiToolSpec", () => {
  it("does not require a credential", () => {
    expect(githubWhoamiToolSpec.requiresCredential).toBe(false);
  });

  it("has no resolveResourceRef (identity-only tool)", () => {
    expect(githubWhoamiToolSpec.resolveResourceRef).toBeUndefined();
  });

  it("accepts empty params", () => {
    expect(githubWhoamiToolSpec.validateParams({})).toEqual({ ok: true, params: {} });
  });

  it("reports the configured identity without resolving a token", async () => {
    const execution = buildExecution({
      label: "Kiln (CTO)",
      githubUsername: "paperclip-kiln",
      commitName: "Kiln Lathe",
      commitEmail: "kiln@example.com"
    });
    const result = (await githubWhoamiToolSpec.perform(execution)) as {
      content: string;
      data: { label: string; githubUsername: string; hasCommitName: boolean; hasCommitEmail: boolean };
    };
    expect(result.content).toContain("Kiln (CTO)");
    expect(result.content).toContain("@paperclip-kiln");
    expect(result.data).toEqual({
      label: "Kiln (CTO)",
      githubUsername: "paperclip-kiln",
      hasCommitName: true,
      hasCommitEmail: true
    });
  });

  it("reports missing commit metadata as false", async () => {
    const execution = buildExecution({ label: "Bot", githubUsername: "bot-user" });
    const result = (await githubWhoamiToolSpec.perform(execution)) as {
      data: { hasCommitName: boolean; hasCommitEmail: boolean };
    };
    expect(result.data.hasCommitName).toBe(false);
    expect(result.data.hasCommitEmail).toBe(false);
  });
});
