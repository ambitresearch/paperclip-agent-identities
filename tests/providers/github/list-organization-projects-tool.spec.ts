import { describe, it, expect, vi } from "vitest";
import { githubListOrganizationProjectsToolSpec } from "../../../src/providers/github/tools/list-organization-projects.js";
import type {
  ProviderToolExecution
} from "../../../src/core/provider-contract.js";
import type { GitHubAgentIdentity } from "../../../src/providers/github/config.js";
import type { GitHubOrgRef } from "../../../src/providers/github/tools/list-organization-projects.js";

const identity = { agentId: "agent-1", identity: { label: "Bot", githubUsername: "bot-user" } };

function orgRef(): GitHubOrgRef {
  return { kind: "github-org", organization: "acme" };
}

function buildCtx(fetchImpl: typeof fetch) {
  return {
    http: { fetch: fetchImpl },
    logger: { info: vi.fn(), error: vi.fn() },
    activity: { log: vi.fn() }
  } as never;
}

describe("githubListOrganizationProjectsToolSpec.validateParams", () => {
  it("rejects a missing organization", () => {
    expect(githubListOrganizationProjectsToolSpec.validateParams({})).toEqual({
      ok: false,
      error: 'organization is required (e.g. "my-org")'
    });
  });

  it("rejects a non-integer first", () => {
    expect(githubListOrganizationProjectsToolSpec.validateParams({ organization: "acme", first: 1.5 }))
      .toEqual({ ok: false, error: "first must be a positive integer if provided" });
  });

  it("rejects first above the max", () => {
    expect(githubListOrganizationProjectsToolSpec.validateParams({ organization: "acme", first: 200 }))
      .toEqual({ ok: false, error: "first must be at most 100" });
  });

  it("accepts a valid param set", () => {
    const res = githubListOrganizationProjectsToolSpec.validateParams({ organization: "acme", query: "roadmap", first: 10 });
    expect(res.ok).toBe(true);
  });
});

describe("githubListOrganizationProjectsToolSpec.resolveResourceRef", () => {
  it("normalizes the organization into a github-org ref", async () => {
    const res = await githubListOrganizationProjectsToolSpec.resolveResourceRef!({
      params: { organization: "ACME" },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: true, ref: { kind: "github-org", organization: "acme" } });
  });

  it("fails closed on an empty organization", async () => {
    const res = await githubListOrganizationProjectsToolSpec.resolveResourceRef!({
      params: { organization: "   " },
      identity,
      ctx: {} as never,
      runCtx: {} as never
    });
    expect(res).toEqual({ ok: false, error: "Invalid organization" });
  });
});

describe("githubListOrganizationProjectsToolSpec.perform", () => {
  function execution(token: string | null, ctx: unknown): ProviderToolExecution<GitHubAgentIdentity, GitHubOrgRef> {
    return {
      token,
      tokenSource: "github-app",
      identity,
      resourceRef: orgRef(),
      params: { organization: "acme" },
      ctx: ctx as never,
      runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p-1", runId: "r-1" } as never
    };
  }

  it("returns an internal error when the token is null", async () => {
    const result = await githubListOrganizationProjectsToolSpec.perform(execution(null, buildCtx(vi.fn())));
    expect(result).toEqual({ error: "Internal error: missing resolved credential." });
  });

  it("returns projects on a successful GraphQL response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: {
          organization: {
            projectsV2: {
              nodes: [
                { id: "PVT_1", number: 1, title: "Roadmap", url: "https://github.com/orgs/acme/projects/1", closed: false, public: true }
              ]
            }
          }
        }
      })
    })) as unknown as typeof fetch;

    const result = await githubListOrganizationProjectsToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      content: "Found 1 project(s) in acme.",
      data: {
        organization: "acme",
        projects: [{ id: "PVT_1", number: 1, title: "Roadmap", url: "https://github.com/orgs/acme/projects/1", closed: false, public: true }]
      }
    });
  });

  it("returns an error when the organization is not found", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { organization: null } })
    })) as unknown as typeof fetch;

    const result = await githubListOrganizationProjectsToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Organization 'acme' was not found or is not accessible to this GitHub App installation."
    });
  });

  it("surfaces GraphQL errors", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ errors: [{ message: "Resource not accessible by integration" }] })
    })) as unknown as typeof fetch;

    const result = await githubListOrganizationProjectsToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Failed to list organization projects: Resource not accessible by integration"
    });
  });

  it("surfaces a non-ok HTTP response", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => "Forbidden"
    })) as unknown as typeof fetch;

    const result = await githubListOrganizationProjectsToolSpec.perform(execution("tok", buildCtx(fetchImpl)));
    expect(result).toEqual({
      error: "Failed to list organization projects: GitHub GraphQL API returned 403. Forbidden"
    });
  });
});
