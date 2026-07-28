import { describe, it, expect, vi } from "vitest";
import { githubUploadPullRequestAssetToolSpec } from "../../../src/providers/github/tools/upload-pull-request-asset.js";
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

function execution(
  token: string | null,
  params: Record<string, unknown>,
  ctx: unknown
): ProviderToolExecution<GitHubAgentIdentity, GitHubRepoRef> {
  return {
    token,
    identity,
    resourceRef: repoRef(),
    params,
    ctx: ctx as never,
    runCtx: { agentId: "agent-1", companyId: "co-1", projectId: "p", runId: "r" } as never
  };
}

const baseParams = {
  repository: "acme/widgets",
  pullNumber: 42,
  fileName: "report.png",
  contentBase64: "aGVsbG8="
};

describe("githubUploadPullRequestAssetToolSpec.validateParams", () => {
  it("rejects a missing repository", () => {
    expect(
      githubUploadPullRequestAssetToolSpec.validateParams({ pullNumber: 1, fileName: "a.png", contentBase64: "x" })
    ).toEqual({ ok: false, error: 'repository is required (e.g. "my-org/my-repo")' });
  });

  it("rejects an invalid pullNumber", () => {
    expect(
      githubUploadPullRequestAssetToolSpec.validateParams({ repository: "acme/widgets", fileName: "a.png", contentBase64: "x" })
    ).toEqual({ ok: false, error: "pullNumber must be a positive integer" });
  });

  it("rejects a missing fileName", () => {
    expect(
      githubUploadPullRequestAssetToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, contentBase64: "x" })
    ).toEqual({ ok: false, error: "fileName is required" });
  });

  it("rejects a missing contentBase64", () => {
    expect(
      githubUploadPullRequestAssetToolSpec.validateParams({ repository: "acme/widgets", pullNumber: 1, fileName: "a.png" })
    ).toEqual({ ok: false, error: "contentBase64 is required" });
  });

  it("accepts valid params", () => {
    expect(githubUploadPullRequestAssetToolSpec.validateParams(baseParams).ok).toBe(true);
  });
});

describe("githubUploadPullRequestAssetToolSpec.perform", () => {
  it("fails closed when the resolved token is null", async () => {
    const result = (await githubUploadPullRequestAssetToolSpec.perform(
      execution(null, baseParams, buildCtx(vi.fn() as never))
    )) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("only ever writes to the dedicated artifacts/pr-<n> branch, never the PR's own branches", async () => {
    const calledUrls: string[] = [];
    const calledBodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calledUrls.push(url);
      if (init?.method === "GET") {
        return new Response("not found", { status: 404 });
      }
      if (init?.body) {
        calledBodies.push(JSON.parse(init.body as string));
      }
      return new Response(JSON.stringify({ content: { sha: "abc123" } }), { status: 201 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as {
      data: { rawUrl: string; branch: string; markdown: string };
    };

    // Every request must reference the artifact branch and its own
    // dedicated contents path — never a PR head/base/merge ref (e.g.
    // "main", "refs/pull/42/merge", or any branch name supplied via a PR
    // object). The tool never fetches or writes to /pulls/{n} at all.
    expect(result.data.branch).toBe("artifacts/pr-42");
    for (const url of calledUrls) {
      expect(url).not.toMatch(/\/pulls\//);
      expect(url).not.toContain("refs/pull");
    }
    for (const body of calledBodies) {
      expect(body.branch).toBe("artifacts/pr-42");
      expect(body.branch).not.toBe("main");
      expect(body.branch).not.toMatch(/^refs\/pull\//);
    }
    expect(result.data.rawUrl).toBe(
      "https://raw.githubusercontent.com/acme/widgets/artifacts/pr-42/pr-42/report.png"
    );
    expect(result.data.markdown).toBe("![report.png](https://raw.githubusercontent.com/acme/widgets/artifacts/pr-42/pr-42/report.png)");
  });

  it("never calls the pull request head/base/merge endpoints", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ content: { sha: "abc123" } }), { status: 201 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    await githubUploadPullRequestAssetToolSpec.perform(exec);

    const urls = (fetchImpl.mock.calls as unknown as Array<[string]>).map(([url]) => url);
    // The upload path only ever touches the Contents API for the artifact
    // path; it must never GET/PUT/PATCH a pull request resource, which is
    // where head/base/merge branch state lives.
    for (const url of urls) {
      expect(url).toContain("/contents/pr-42/report.png");
    }
    expect(urls.every((url) => !/\/pulls\/\d+(\/|$)/.test(url))).toBe(true);
  });

  it("uses the non-image markdown form for non-image files", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ content: { sha: "abc123" } }), { status: 201 });
    });
    const exec = execution("tok", { ...baseParams, fileName: "log.txt" }, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { data: { markdown: string } };
    expect(result.data.markdown).toBe(
      "[log.txt](https://raw.githubusercontent.com/acme/widgets/artifacts/pr-42/pr-42/log.txt)"
    );
  });

  it("includes the existing file's sha on update instead of duplicating", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") {
        return new Response(JSON.stringify({ sha: "existing-sha" }), { status: 200 });
      }
      const body = JSON.parse(init!.body as string);
      expect(body.sha).toBe("existing-sha");
      return new Response(JSON.stringify({ content: { sha: "new-sha" } }), { status: 200 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { data: { branch: string } };
    expect(result.data.branch).toBe("artifacts/pr-42");
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return new Response("not found", { status: 404 });
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK PUT response", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("401");
    expect(result.error).toContain("Bad credentials");
  });

  it("logs activity metadata without leaking the token", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "GET") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ content: { sha: "abc123" } }), { status: 201 });
    });
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token", baseParams, buildCtx(fetchImpl as never, activityLog));
    await githubUploadPullRequestAssetToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string; branch: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.branch).toBe("artifacts/pr-42");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});
