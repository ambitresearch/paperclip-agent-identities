import { describe, it, expect, vi } from "vitest";
import { githubAssignToCurrentUserToolSpec } from "../../../src/providers/github/tools/assign-to-current-user.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type {
  ProviderToolExecution
} from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "paperclip-bot-agent" } };

function repoRef(): GitHubRepoRef {
  return { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" };
}

function buildCtx(fetchImpl: typeof fetch, activityLog = vi.fn()) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: activityLog }
  } as never;
}

describe("githubAssignToCurrentUserToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(githubAssignToCurrentUserToolSpec.validateParams({ issueNumber: 1 }))
      .toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects a missing/invalid issueNumber", () => {
    expect(githubAssignToCurrentUserToolSpec.validateParams({ repository: "acme/widgets" }))
      .toEqual({ ok: false, error: "issueNumber must be a positive integer" });

    expect(githubAssignToCurrentUserToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 0 }))
      .toEqual({ ok: false, error: "issueNumber must be a positive integer" });
  });

  it("has no `username`/`assignee` parameter in its schema", () => {
    const props = (githubAssignToCurrentUserToolSpec.metadata as { parametersSchema: { properties: Record<string, unknown> } })
      .parametersSchema.properties;
    expect(props.username).toBeUndefined();
    expect(props.assignee).toBeUndefined();
    expect(props.githubUsername).toBeUndefined();
  });

  it("accepts a valid param set", () => {
    const res = githubAssignToCurrentUserToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 7 });
    expect(res).toEqual({ ok: true, params: { repository: "acme/widgets", issueNumber: 7, paperclipIssueId: undefined } });
  });
});

describe("githubAssignToCurrentUserToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubAssignToCurrentUserToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", issueNumber: 7 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository", async () => {
    const res = await githubAssignToCurrentUserToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", issueNumber: 7 },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubAssignToCurrentUserToolSpec.perform", () => {
  function execution(
    token: string | null,
    identityOverride: GitHubAgentIdentity = identity.identity
  ): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity: { agentId: "agent-1", identity: identityOverride },
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", issueNumber: 7 },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubAssignToCurrentUserToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("proves the assignee sent to GitHub is always the configured agent identity, never a caller-supplied value or a personal-token account", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/issues/7", assignees: [{ login: "paperclip-bot-agent" }] }),
        { status: 200 }
      );
    });
    const exec = execution("installation-token-abc", { label: "Bot", githubUsername: "paperclip-bot-agent" });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    await githubAssignToCurrentUserToolSpec.perform(exec);

    // The assignees array sent to GitHub is derived solely from
    // execution.identity.identity.githubUsername (the GitHub App
    // installation identity resolved by the provider's credential/identity
    // config), and params never carried a username to begin with — so there
    // is no code path by which a different account, or a personal token's
    // associated user, could end up in this request body.
    expect(capturedBody).toEqual({ assignees: ["paperclip-bot-agent"] });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/7/assignees");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer installation-token-abc");
  });

  it("uses a distinct configured identity's username per agent, proving no shared/fallback account", async () => {
    let capturedBody: unknown;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/issues/7", assignees: [{ login: "paperclip-other-agent" }] }),
        { status: 200 }
      );
    });
    const exec = execution("tok", { label: "Other Bot", githubUsername: "paperclip-other-agent" });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    await githubAssignToCurrentUserToolSpec.perform(exec);

    expect(capturedBody).toEqual({ assignees: ["paperclip-other-agent"] });
  });

  it("returns an error without assigning when GitHub responds with a failure status", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);

    const result = (await githubAssignToCurrentUserToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("404");
    expect(result.error).toContain("Not Found");
  });

  it("awaits the activity audit write before returning success", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/issues/7", assignees: [{ login: "paperclip-bot-agent" }] }),
      { status: 200 }
    ));
    let finishLog: (() => void) | undefined;
    const activityLog = vi.fn(() => new Promise<void>((resolve) => { finishLog = resolve; }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    let settled = false;
    const result = githubAssignToCurrentUserToolSpec.perform(exec).then(() => { settled = true; });
    await vi.waitFor(() => expect(activityLog).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishLog?.();
    await result;
  });

  it("returns the resulting assignee list", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({
        number: 7,
        html_url: "https://github.com/acme/widgets/issues/7",
        assignees: [{ login: "existing-human" }, { login: "paperclip-bot-agent" }]
      }),
      { status: 200 }
    ));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubAssignToCurrentUserToolSpec.perform(exec)) as { data: { assignees: string[] } };
    expect(result.data.assignees).toEqual(["existing-human", "paperclip-bot-agent"]);
  });
});
