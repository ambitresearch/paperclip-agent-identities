import { describe, it, expect, vi } from "vitest";
import { createProviderTool } from "../src/core/tool-pipeline.js";
import type { IdentityProvider, ProviderToolSpec } from "../src/core/provider-contract.js";
import type { ResourceReference } from "../src/core/resource-reference.js";

interface Ref extends ResourceReference {
  kind: "repo";
  fullName: string;
}

function buildFixture(
  overrides: {
    resolveIdentity?: () => Promise<{ agentId: string; identity: { label: string } }>;
    spec?: Partial<ProviderToolSpec<{ label: string }, Ref>>;
    resolveCredential?: () => Promise<{ token: string; secrets: readonly string[] }>;
  } = {},
) {
  const calls: string[] = [];
  const provider = {
    id: "test",
    definition: { id: "test", name: "Test", status: "enabled", description: "" },
    validateConfig: () => ({}),
    projectPluginConfig: () => ({}),
    resolveCredential: overrides.resolveCredential ?? (async () => {
      calls.push("resolveCredential");
      return { token: "SECRET-TOKEN", secrets: ["SECRET-TOKEN"] };
    }),
    tools: [],
    manifestTools: [],
  } as unknown as IdentityProvider<{ label: string }, Ref>;

  const toolSpec: ProviderToolSpec<{ label: string }, Ref> = {
    name: "test_tool",
    metadata: { displayName: "Test" },
    validateParams: (raw) => {
      calls.push("validateParams");
      const repo = (raw as { repo?: unknown }).repo;
      return typeof repo === "string"
        ? { ok: true, params: { repo } }
        : { ok: false, error: "repo is required" };
    },
    resolveResourceRef: async ({ params }) => {
      calls.push("resolveResourceRef");
      const repo = (params as { repo?: unknown }).repo;
      return repo === "ok/repo"
        ? { ok: true, ref: { kind: "repo", fullName: "ok/repo" } }
        : { ok: false, error: `Invalid repo: ${String(repo)}` };
    },
    perform: async ({ token, resourceRef }) => {
      calls.push("perform");
      return { echoedToken: token, repo: resourceRef?.fullName };
    },
    ...overrides.spec,
  };

  const deps = {
    resolveIdentity:
      overrides.resolveIdentity ??
      (async () => {
        calls.push("resolveIdentity");
        return { agentId: "agent-1", identity: { label: "Bot" } };
      }),
    redactSecrets: <T,>(value: T, secrets: readonly string[]): T => {
      calls.push("redactSecrets");
      let json = JSON.stringify(value);
      for (const secret of secrets) json = json.split(secret).join("[REDACTED]");
      return JSON.parse(json) as T;
    },
  };

  const activityLog = vi.fn().mockResolvedValue(undefined);
  const tool = createProviderTool(provider, toolSpec, { activity: { log: activityLog }, logger: { error: vi.fn() } } as never, deps);
  return { calls, tool, activityLog };
}

describe("tool pipeline security ordering", () => {
  it("denies invalid params before any secret is resolved", async () => {
    const { calls, tool } = buildFixture();
    const result = await tool.handler({}, { agentId: "agent-1" } as never);
    expect(result).toEqual({ error: "repo is required" });
    expect(calls).not.toContain("resolveCredential");
    expect(calls).not.toContain("resolveIdentity");
  });

  it("denies an invalid resource ref before any secret is resolved", async () => {
    const { calls, tool } = buildFixture();
    const result = await tool.handler({ repo: "not-a-repo" }, { agentId: "agent-1" } as never);
    expect(result).toEqual({ error: "Invalid repo: not-a-repo" });
    expect(calls).not.toContain("resolveCredential");
    expect(calls.indexOf("resolveResourceRef")).toBeGreaterThan(calls.indexOf("resolveIdentity"));
  });

  it("runs the full pipeline in security order and redacts the token", async () => {
    const { calls, tool } = buildFixture();
    const result = await tool.handler({ repo: "ok/repo" }, { agentId: "agent-1" } as never);
    expect(calls).toEqual([
      "validateParams",
      "resolveIdentity",
      "resolveResourceRef",
      "resolveCredential",
      "perform",
      "redactSecrets",
    ]);
    expect(result).toEqual({ echoedToken: "[REDACTED]", repo: "ok/repo" });
  });

  it("fails closed when identity resolution throws", async () => {
    const { calls, tool } = buildFixture({
      resolveIdentity: async () => {
        throw new Error("no sidecar identity");
      },
    });
    const result = await tool.handler({ repo: "ok/repo" }, { agentId: "agent-1" } as never);
    expect(result).toEqual({
      error: "test_tool failed closed for agent 'agent-1': no sidecar identity",
    });
    expect(calls).not.toContain("resolveCredential");
    expect(calls).not.toContain("perform");
  });

  it("does not copy credential-resolution errors into activity metadata", async () => {
    const { activityLog, tool } = buildFixture({
      resolveCredential: async () => { throw new Error("SECRET-TOKEN"); },
    });
    await expect(tool.handler({ repo: "ok/repo" }, { agentId: "agent-1", runId: "run-1", companyId: "company-1" } as never))
      .resolves.toEqual({ error: "Failed to resolve agent identity authentication credentials." });
    expect(activityLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ reason: expect.anything() }),
    }));
    expect(JSON.stringify(activityLog.mock.calls)).not.toContain("SECRET-TOKEN");
  });

  it("keeps a stable credential error when activity logging fails", async () => {
    const { activityLog, tool } = buildFixture({
      resolveCredential: async () => { throw new Error("credential failure"); },
    });
    activityLog.mockRejectedValueOnce(new Error("activity unavailable"));
    await expect(tool.handler({ repo: "ok/repo" }, { agentId: "agent-1", runId: "run-1", companyId: "company-1" } as never))
      .resolves.toEqual({ error: "Failed to resolve agent identity authentication credentials." });
  });

  it("redacts resolved secrets when provider execution throws", async () => {
    const { tool } = buildFixture({
      spec: {
        perform: async () => { throw new Error("upstream leaked SECRET-TOKEN"); },
      },
    });
    await expect(tool.handler({ repo: "ok/repo" }, { agentId: "agent-1" } as never))
      .resolves.toEqual({ error: "test_tool failed: upstream leaked [REDACTED]" });
  });

  it("skips credential resolution when the tool sets requiresCredential: false", async () => {
    const { calls, tool } = buildFixture({
      spec: {
        requiresCredential: false,
        resolveResourceRef: undefined,
        perform: async ({ token }) => {
          calls.push("perform");
          return { echoedToken: token };
        },
      },
    });
    const result = await tool.handler({ repo: "ok/repo" }, { agentId: "agent-1" } as never);
    expect(calls).toEqual(["validateParams", "resolveIdentity", "perform", "redactSecrets"]);
    expect(calls).not.toContain("resolveCredential");
    expect(calls).not.toContain("resolveResourceRef");
    expect(result).toEqual({ echoedToken: null });
  });
});
