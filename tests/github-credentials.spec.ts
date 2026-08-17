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

function fakeCtx(resolveSecret = vi.fn(async (ref: string | { secretId: string }) => (
  `secret:${typeof ref === "string" ? ref : ref.secretId}`
))): PluginContext {
  return {
    secrets: { resolve: resolveSecret },
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

    // `source` is carried through, not dropped: tools that must distinguish a
    // token bound to this agent's own App from an operator-supplied one have no
    // other trustworthy signal.
    expect(credential).toEqual({ token: "ghs_TOKEN", secrets: ["ghs_TOKEN"], source: "token-file" });
    expect(credential.secrets).toHaveLength(1);
    expect(credential.secrets[0]).toBe("ghs_TOKEN");
  });

  it("reports the github-app source when the sidecar minted an installation token", async () => {
    resolveIdentityTokenMock.mockResolvedValue({ token: "ghs_APP", source: "github-app" });

    const credential = await resolveGitHubCredential({ identity, ctx: fakeCtx(), runCtx });

    expect(credential.source).toBe("github-app");
  });

  it("passes the resolved identity plus ctx-bound secret and fetch resolvers to resolveIdentityToken", async () => {
    resolveIdentityTokenMock.mockResolvedValue({ token: "ghs_ABC", source: "plugin-secret" });
    const resolveSecret = vi.fn(async (ref: string | { secretId: string }) => (
      `secret:${typeof ref === "string" ? ref : ref.secretId}`
    ));
    const ctx = fakeCtx(resolveSecret);

    await resolveGitHubCredential({ identity, ctx, runCtx });

    expect(resolveIdentityTokenMock).toHaveBeenCalledTimes(1);
    const [passedIdentity, passedResolveSecret, passedFetch] = resolveIdentityTokenMock.mock.calls[0];
    expect(passedIdentity).toBe(identity);
    expect(typeof passedResolveSecret).toBe("function");
    expect(typeof passedFetch).toBe("function");

    await expect(passedResolveSecret("00000000-0000-4000-8000-000000000001")).resolves.toBe("secret:00000000-0000-4000-8000-000000000001");
    expect(resolveSecret).toHaveBeenCalledWith({
      type: "secret_ref",
      secretId: "00000000-0000-4000-8000-000000000001",
      version: "latest",
    });
  });
});
