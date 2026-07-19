import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ResolvedAgentIdentity } from "../src/core/agent-identity.js";
import type { GitHubAgentIdentity } from "../src/providers/github/config.js";

const { resolveIdentityTokenMock } = vi.hoisted(() => ({
  resolveIdentityTokenMock: vi.fn(),
}));

vi.mock("../src/credential-sidecar.js", () => ({
  resolveIdentityToken: resolveIdentityTokenMock,
}));

import { resolveGitHubCredential } from "../src/providers/github/credentials.js";

function fakeCtx(): PluginContext {
  return {
    secrets: { resolve: async (ref: string) => `secret:${ref}` },
    http: { fetch: async () => new Response("{}") },
  } as unknown as PluginContext;
}

const identity: ResolvedAgentIdentity<GitHubAgentIdentity> = {
  agentId: "agent-1",
  identity: { label: "Bot", githubUsername: "bot-user" },
};
const runCtx = {
  agentId: "agent-1",
  runId: "run-1",
  companyId: "company-1",
  projectId: "project-1",
};

describe("resolveGitHubCredential", () => {
  beforeEach(() => {
    resolveIdentityTokenMock.mockReset();
  });

  it("wraps the resolved token into a ResolvedCredential with the token as its only secret", async () => {
    resolveIdentityTokenMock.mockResolvedValue({ token: "ghs_TOKEN", source: "token-file" });

    const credential = await resolveGitHubCredential({ identity, ctx: fakeCtx(), runCtx });

    expect(credential).toEqual({ token: "ghs_TOKEN", secrets: ["ghs_TOKEN"] });
    expect(credential.secrets).toHaveLength(1);
    expect(credential.secrets[0]).toBe("ghs_TOKEN");
  });

  it("passes the resolved identity plus ctx-bound secret and fetch resolvers to resolveIdentityToken", async () => {
    resolveIdentityTokenMock.mockResolvedValue({ token: "ghs_ABC", source: "plugin-secret" });
    const ctx = fakeCtx();

    await resolveGitHubCredential({ identity, ctx, runCtx });

    expect(resolveIdentityTokenMock).toHaveBeenCalledTimes(1);
    const [passedIdentity, passedResolveSecret, passedFetch] = resolveIdentityTokenMock.mock.calls[0];
    expect(passedIdentity).toBe(identity);
    expect(typeof passedResolveSecret).toBe("function");
    expect(typeof passedFetch).toBe("function");

    await expect(passedResolveSecret("ref-1")).resolves.toBe("secret:ref-1");
  });
});
