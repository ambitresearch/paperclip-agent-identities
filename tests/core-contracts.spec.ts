import { describe, it, expect } from "vitest";
import { isResourceReference } from "../src/core/resource-reference.js";
import { resolveAgentIdentity } from "../src/core/agent-identity.js";

describe("core contracts", () => {
  it("guards resource references by string kind", () => {
    expect(isResourceReference({ kind: "repo" })).toBe(true);
    expect(isResourceReference({ kind: 1 })).toBe(false);
    expect(isResourceReference(null)).toBe(false);
    expect(isResourceReference("repo")).toBe(false);
  });

  it("resolves the identity for the running agent", () => {
    const projected = { identities: { "agent-1": { label: "Bot" } } };
    const runCtx = { agentId: "agent-1", companyId: "c1" } as never;
    expect(resolveAgentIdentity(projected, runCtx)).toEqual({
      agentId: "agent-1",
      identity: { label: "Bot" },
    });
  });

  it("throws when no identity is configured for the agent", () => {
    const runCtx = { agentId: "missing", companyId: "c1" } as never;
    expect(() => resolveAgentIdentity({ identities: {} }, runCtx)).toThrow(
      "No agent identity configured for agent 'missing'.",
    );
  });
});
