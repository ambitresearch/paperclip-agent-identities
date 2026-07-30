import { describe, it, expect, vi } from "vitest";
import { githubUpdateIssueToolSpec } from "../../../src/providers/github/tools/update-issue.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type { ProviderToolExecution } from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

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

describe("githubUpdateIssueToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubUpdateIssueToolSpec.validateParams({ issueNumber: 1, title: "x" })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects when no updatable field is provided", () => {
    expect(
      githubUpdateIssueToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 1 })
    ).toEqual({
      ok: false,
      error: "At least one updatable field (title, body, state, stateReason, labels, assignees, milestone) is required"
    });
  });

  it("rejects an invalid state", () => {
    expect(
      githubUpdateIssueToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 1, state: "merged" })
    ).toEqual({ ok: false, error: 'state must be one of "open", "closed" if provided' });
  });

  it("accepts a title-only update", () => {
    expect(githubUpdateIssueToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 1, title: "New" }).ok).toBe(true);
  });

  it("rejects a non-array labels", () => {
    expect(
      githubUpdateIssueToolSpec.validateParams({ repository: "acme/widgets", issueNumber: 1, labels: "bug" })
    ).toEqual({ ok: false, error: "labels must be an array of strings if provided" });
  });
});

describe("githubUpdateIssueToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubUpdateIssueToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", issueNumber: 1, title: "x" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });
});

describe("githubUpdateIssueToolSpec.perform", () => {
  function execution(token: string | null, overrides: Record<string, unknown> = {}): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", issueNumber: 7, title: "Updated title", ...overrides },
      ctx: buildCtx(vi.fn() as never),
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
    };
  }

  it("fails closed when the resolved token is null", async () => {
    const result = (await githubUpdateIssueToolSpec.perform(execution(null))) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("patches the issue and appends the AI-authorship footer to body when provided", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.github.com/repos/acme/widgets/issues/7");
      expect(init.method).toBe("PATCH");
      const body = JSON.parse(init.body as string);
      expect(body.body).toContain("New body");
      expect(body.body).toContain("posted by an AI agent via Paperclip");
      return new Response(
        JSON.stringify({ number: 7, title: "Updated title", state: "open", html_url: "https://github.com/acme/widgets/issues/7" }),
        { status: 200 }
      );
    });
    const exec = execution("tok", { body: "New body" });
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubUpdateIssueToolSpec.perform(exec)) as { data: { number: number } };
    expect(result.data.number).toBe(7);
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubUpdateIssueToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: "Validation failed" }), { status: 422 }));
    const exec = execution("tok");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never);
    const result = (await githubUpdateIssueToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("422");
    expect(result.error).toContain("Validation failed");
  });

  it("logs activity metadata without ever including the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ number: 7, title: "t", state: "open", html_url: "u" }),
      { status: 200 }
    ));
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token");
    (exec as { ctx: unknown }).ctx = buildCtx(fetchImpl as never, activityLog);
    await githubUpdateIssueToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});
