import { describe, it, expect, vi } from "vitest";
import { createProviderTool } from "../src/core/tool-pipeline.js";
import type { IdentityProvider, ProviderToolSpec } from "../src/core/provider-contract.js";
import type { ResourceReference } from "../src/core/resource-reference.js";
import { slackBotPostMessageToolSpec } from "../src/providers/slack/tools/post-message.js";
import { resolveSlackCredential } from "../src/providers/slack/credentials.js";
import type { SlackAgentIdentity } from "../src/providers/slack/config.js";

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

  it("denies a wrong-team resource ref before credentials are ever resolved (fails closed at the pipeline level, not just per-provider)", async () => {
    const { calls, tool } = buildFixture({
      spec: {
        resolveResourceRef: async ({ params }) => {
          calls.push("resolveResourceRef");
          const repo = (params as { repo?: unknown }).repo;
          // Simulate a cross-team/cross-tenant resource ref: the ref itself
          // resolves syntactically, but belongs to a different team than the
          // agent's identity, so it must be denied before any credential work.
          if (repo === "other-team/repo") {
            return { ok: false, error: "denied: team mismatch" };
          }
          return repo === "ok/repo"
            ? { ok: true, ref: { kind: "repo", fullName: "ok/repo" } }
            : { ok: false, error: `Invalid repo: ${String(repo)}` };
        },
      },
    });
    const result = await tool.handler({ repo: "other-team/repo" }, { agentId: "agent-1" } as never);
    expect(result).toEqual({ error: "denied: team mismatch" });
    expect(calls).toEqual(["validateParams", "resolveIdentity", "resolveResourceRef"]);
    expect(calls).not.toContain("resolveCredential");
    expect(calls).not.toContain("perform");
    expect(calls).not.toContain("redactSecrets");
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

describe("tool pipeline security ordering — real Slack provider regression", () => {
  // Regression for the Slack-specific wrong-team review finding: exercise
  // `slack_bot_post_message` through the actual generic `createProviderTool`
  // pipeline (not a fixture stand-in for it), with a wrong-team target, and
  // prove neither Slack's credential resolver nor its `chat.postMessage`
  // fetch/perform path is ever invoked. The team-mismatch denial must happen
  // entirely inside `resolveResourceRef` (see channel-ref.ts), before step 4
  // (resolveCredential) runs.
  it("denies slack_bot_post_message on a wrong-team target before the Slack credential resolver or chat.postMessage fetch ever runs", async () => {
    const slackIdentity: SlackAgentIdentity = {
      label: "Bot",
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789"
    };

    const resolveCredentialSpy = vi.fn(resolveSlackCredential);
    const fetchSpy = vi.fn(async () => {
      throw new Error("chat.postMessage must never be called for a wrong-team target");
    });

    const provider = {
      id: "slack",
      definition: { id: "slack", name: "Slack", status: "coming-soon", description: "" },
      validateConfig: () => ({}),
      projectPluginConfig: () => ({}),
      resolveCredential: resolveCredentialSpy,
      tools: [slackBotPostMessageToolSpec],
      manifestTools: []
    } as unknown as IdentityProvider<SlackAgentIdentity, ResourceReference>;

    const deps = {
      resolveIdentity: async () => ({ agentId: "agent-1", identity: slackIdentity }),
      redactSecrets: <T,>(value: T): T => value
    };

    const ctx = {
      activity: { log: vi.fn().mockResolvedValue(undefined) },
      logger: { error: vi.fn(), info: vi.fn() },
      http: { fetch: fetchSpy },
      secrets: { resolve: vi.fn() }
    } as never;

    const tool = createProviderTool(
      provider,
      slackBotPostMessageToolSpec as unknown as ProviderToolSpec<SlackAgentIdentity, ResourceReference>,
      ctx,
      deps
    );

    const result = await tool.handler(
      { channel: "C0123456789", text: "hello", teamId: "T9999999999" },
      { agentId: "agent-1", companyId: "co-1", projectId: "proj-1", runId: "run-1" } as never
    );

    expect(result).toEqual({
      error: "Slack resource denied: workspace mismatch. Expected team 'T0123456789', got 'T9999999999'."
    });
    expect(resolveCredentialSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the run company scope and bound bot-token object ref on a real Slack happy path", async () => {
    const companyId = "co-1";
    const botToken = "xoxb-resolved-test-token";
    const botTokenRef = {
      type: "secret_ref",
      secretId: "00000000-0000-4000-8000-000000000010",
      version: "latest",
    } as const;
    const slackIdentity: SlackAgentIdentity = {
      label: "Bot",
      teamId: "T0123456789",
      appId: "A0123456789",
      botUserId: "U0123456789",
    };
    const getConfig = vi.fn(async () => ({
      identities: {
        "agent-1": {
          ...slackIdentity,
          credentials: { botToken: botTokenRef },
        },
      },
    }));
    const resolveSecret = vi.fn(async () => botToken);
    const slackApiFetch = vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      if (path.endsWith("/auth.test")) {
        return new Response(
          JSON.stringify({
            ok: true,
            team_id: slackIdentity.teamId,
            user_id: slackIdentity.botUserId,
            bot_id: "B0123456789",
          }),
          { status: 200 },
        );
      }
      if (path.endsWith("/chat.postMessage")) {
        return new Response(
          JSON.stringify({ ok: true, ts: "1719000001.000100", channel: "C0123456789" }),
          { status: 200 },
        );
      }
      if (path.endsWith("/chat.getPermalink")) {
        return new Response(
          JSON.stringify({ ok: true, permalink: "https://acme.slack.com/archives/C0123456789/p1719000001000100" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected Slack API URL: ${input}`);
    });
    const provider = {
      id: "slack",
      definition: { id: "slack", name: "Slack", status: "coming-soon", description: "" },
      validateConfig: () => ({}),
      projectPluginConfig: () => ({}),
      resolveCredential: resolveSlackCredential,
      tools: [slackBotPostMessageToolSpec],
      manifestTools: [],
    } as unknown as IdentityProvider<SlackAgentIdentity, ResourceReference>;
    const ctx = {
      activity: { log: vi.fn().mockResolvedValue(undefined) },
      logger: { error: vi.fn(), info: vi.fn() },
      http: { fetch: slackApiFetch },
      config: { get: getConfig },
      secrets: { resolve: resolveSecret },
    } as never;
    const tool = createProviderTool(
      provider,
      slackBotPostMessageToolSpec as unknown as ProviderToolSpec<SlackAgentIdentity, ResourceReference>,
      ctx,
      {
        resolveIdentity: async () => ({ agentId: "agent-1", identity: slackIdentity }),
        redactSecrets: <T,>(value: T): T => value,
      },
    );

    const result = await tool.handler(
      { channel: "C0123456789", text: "hello", teamId: slackIdentity.teamId },
      { agentId: "agent-1", companyId, projectId: "proj-1", runId: "run-1" } as never,
    );

    expect(result).toMatchObject({
      content: "Posted message to C0123456789",
      data: { team: slackIdentity.teamId, conversation: "C0123456789" },
    });
    expect(getConfig).toHaveBeenCalledOnce();
    expect(getConfig).toHaveBeenCalledWith(companyId);
    expect(resolveSecret).toHaveBeenCalledOnce();
    expect(resolveSecret).toHaveBeenCalledWith(botTokenRef, {
      companyId,
      configPath: "identities.agent-1.credentials.botToken",
    });
  });
});
