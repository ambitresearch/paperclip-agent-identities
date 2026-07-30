import { describe, it, expect, vi } from "vitest";
import { githubAddPullRequestToProjectToolSpec } from "../../../src/providers/github/tools/add-pull-request-to-project.js";
import type { GitHubRepoRef } from "../../../src/providers/github/repo-ref.js";
import type {
  ProviderToolExecution
} from "../../../src/core/provider-contract.js";
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

describe("githubAddPullRequestToProjectToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(githubAddPullRequestToProjectToolSpec.validateParams({ pullNumber: 1, projectId: "PVT_1" }))
      .toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects an invalid pullNumber", () => {
    expect(githubAddPullRequestToProjectToolSpec.validateParams({ repository: "acme/widgets", pullNumber: -1, projectId: "PVT_1" }))
      .toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("rejects a missing projectId", () => {
    expect(githubAddPullRequestToProjectToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1 }))
      .toEqual({ ok: false, error: "projectId is required (the Projects v2 node ID)" });
  });

  it("accepts a full valid param set", () => {
    const res = githubAddPullRequestToProjectToolSpec.validateParams({
      repository: "acme/widgets", pullNumber: 5, projectId: "PVT_1"
    });
    expect(res.ok).toBe(true);
  });
});

describe("githubAddPullRequestToProjectToolSpec.resolveResourceRef", () => {
  it("normalizes the repository into a github-repo ref", async () => {
    const res = await githubAddPullRequestToProjectToolSpec.resolveResourceRef!({
      params: { repository: "acme/widgets", pullNumber: 5, projectId: "PVT_1" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-repo", owner: "acme", repo: "widgets", fullName: "acme/widgets" } });
  });

  it("fails closed on an invalid repository", async () => {
    const res = await githubAddPullRequestToProjectToolSpec.resolveResourceRef!({
      params: { repository: "not a repo", pullNumber: 5, projectId: "PVT_1" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid repository format" });
  });
});

describe("githubAddPullRequestToProjectToolSpec.perform", () => {
  function execution(token: string | null, ctx: unknown): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
    return {
      token,
      identity,
      resourceRef: repoRef(),
      params: { repository: "acme/widgets", pullNumber: 5, projectId: "PVT_1" },
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never
    };
  }

  it("returns an internal error when the token is null", async () => {
    const result = await githubAddPullRequestToProjectToolSpec.perform(execution(null, buildCtx(vi.fn())));
    expect(result).toEqual({ error: "Internal error: missing resolved credential." });
  });

  it("adds the pull request to the project on success", async () => {
    const activityLog = vi.fn();
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("pullRequest(number:")) {
        return {
          ok: true,
          json: async () => ({ data: { repository: { pullRequest: { id: "PR_node_1", url: "https://github.com/acme/widgets/pull/5" } } } })
        };
      }
      return {
        ok: true,
        json: async () => ({ data: { addProjectV2ItemById: { item: { id: "PVTI_1" } } } })
      };
    }) as unknown as typeof fetch;

    const result = await githubAddPullRequestToProjectToolSpec.perform(execution("tok", buildCtx(fetchImpl, activityLog)));
    expect(result).toEqual({
      content: "Added PR #5 (https://github.com/acme/widgets/pull/5) to project PVT_1.",
      data: {
        repository: "acme/widgets",
        pullNumber: 5,
        pullRequestUrl: "https://github.com/acme/widgets/pull/5",
        projectId: "PVT_1",
        projectItemId: "PVTI_1"
      }
    });
    expect(activityLog).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the pull request is not found", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { repository: { pullRequest: null } } })
    })) as unknown as typeof fetch;

    const result = await githubAddPullRequestToProjectToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({ error: "Pull request #5 was not found in acme/widgets." });
  });

  it("surfaces a GraphQL error from the lookup", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: "Resource not accessible by integration" }] })
    })) as unknown as typeof fetch;

    const result = await githubAddPullRequestToProjectToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Failed to look up pull request #5 in acme/widgets: Resource not accessible by integration"
    });
  });

  it("surfaces a GraphQL error from the mutation", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.query.includes("pullRequest(number:")) {
        return {
          ok: true,
          json: async () => ({ data: { repository: { pullRequest: { id: "PR_node_1", url: "https://github.com/acme/widgets/pull/5" } } } })
        };
      }
      return {
        ok: true,
        json: async () => ({ errors: [{ message: "projectId is not a valid ID" }] })
      };
    }) as unknown as typeof fetch;

    const result = await githubAddPullRequestToProjectToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Failed to add pull request #5 to project 'PVT_1': projectId is not a valid ID"
    });
  });
});
