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
    tokenSource: "github-app",
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

// Builds a fetch mock that models a brand-new artifact branch: the
// heads/artifacts/pr-N ref lookup 404s, the repo lookup returns a default
// branch, the default branch's ref lookup returns a base SHA, the ref
// creation succeeds, the contents GET (existence probe) 404s, and the
// contents PUT succeeds.
function newBranchFetchImpl() {
  const calledUrls: string[] = [];
  const calledBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calledUrls.push(url);
    if (init?.body) {
      calledBodies.push({ url, body: JSON.parse(init.body as string) });
    }
    if (url.includes("/git/ref/") && url.includes("artifacts")) {
      return new Response("not found", { status: 404 });
    }
    if (init?.method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
    }
    if (url.includes("/git/ref/") && url.includes("main")) {
      return new Response(JSON.stringify({ object: { sha: "base-sha-123" } }), { status: 200 });
    }
    if (init?.method === "POST" && url.endsWith("/git/refs")) {
      return new Response(JSON.stringify({ ref: "refs/heads/artifacts/pr-42" }), { status: 201 });
    }
    if (init?.method === "GET" && url.includes("/contents/")) {
      return new Response("not found", { status: 404 });
    }
    if (init?.method === "PUT" && url.includes("/contents/")) {
      return new Response(
        JSON.stringify({ content: { sha: "abc123" }, commit: { sha: "commit-sha-abc123" } }),
        { status: 201 }
      );
    }
    return new Response("unexpected", { status: 500 });
  });
  return { fetchImpl, calledUrls, calledBodies };
}

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

  it("rejects a fileName with a path separator (traversal attempt)", () => {
    const result = githubUploadPullRequestAssetToolSpec.validateParams({
      ...baseParams,
      fileName: "../pr-43/report.log"
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a fileName that is just '..'", () => {
    const result = githubUploadPullRequestAssetToolSpec.validateParams({ ...baseParams, fileName: ".." });
    expect(result.ok).toBe(false);
  });

  it("rejects a fileName containing a forward slash", () => {
    const result = githubUploadPullRequestAssetToolSpec.validateParams({
      ...baseParams,
      fileName: "sub/dir/report.log"
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a fileName containing a backslash", () => {
    const result = githubUploadPullRequestAssetToolSpec.validateParams({
      ...baseParams,
      fileName: "sub\\report.log"
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a safe fileName with dots, dashes, and underscores", () => {
    const result = githubUploadPullRequestAssetToolSpec.validateParams({
      ...baseParams,
      fileName: "report_v2-final.log"
    });
    expect(result.ok).toBe(true);
  });
});

describe("githubUploadPullRequestAssetToolSpec.perform", () => {
  it("fails closed when the resolved token is null", async () => {
    const result = (await githubUploadPullRequestAssetToolSpec.perform(
      execution(null, baseParams, buildCtx(vi.fn() as never))
    )) as { error: string };
    expect(result.error).toBe("Internal error: missing resolved credential.");
  });

  it("creates the artifact branch from the default branch HEAD on first upload, then writes the file", async () => {
    const { fetchImpl, calledUrls, calledBodies } = newBranchFetchImpl();
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as {
      data: { rawUrl: string; branch: string; markdown: string };
    };

    expect(result.data.branch).toBe("artifacts/pr-42");

    // Must check for the artifact ref, resolve the default branch and its
    // SHA, then explicitly create the ref -- not just PUT to Contents and
    // hope GitHub creates the branch (it does not).
    const refCreateCall = calledBodies.find((c) => c.url.endsWith("/git/refs"));
    expect(refCreateCall).toBeTruthy();
    expect(refCreateCall!.body).toMatchObject({ ref: "refs/heads/artifacts/pr-42", sha: "base-sha-123" });

    // Every request must reference the artifact branch and its own
    // dedicated contents path — never a PR head/base/merge ref (e.g.
    // "main" as the *target* content branch, "refs/pull/42/merge", or any
    // branch name supplied via a PR object). The tool never fetches or
    // writes to /pulls/{n} at all.
    for (const url of calledUrls) {
      expect(url).not.toMatch(/\/pulls\//);
      expect(url).not.toContain("refs/pull");
    }
    const contentsBodies = calledBodies.filter((c) => c.url.includes("/contents/"));
    for (const { body } of contentsBodies) {
      expect(body.branch).toBe("artifacts/pr-42");
      expect(body.branch).not.toBe("main");
    }
    expect(result.data.rawUrl).toBe(
      "https://github.com/acme/widgets/blob/commit-sha-abc123/pr-42/report.png?raw=true"
    );
    expect(result.data.markdown).toBe("![report.png](https://github.com/acme/widgets/blob/commit-sha-abc123/pr-42/report.png?raw=true)");
    expect((result as unknown as { data: { commitSha: string } }).data.commitSha).toBe("commit-sha-abc123");
  });

  it("treats a 422 'ref already exists' race on branch creation as success after verifying the ref exists", async () => {
    let refCheckCount = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        refCheckCount += 1;
        // First check (before create attempt): branch doesn't exist yet.
        // Second check (verification after the 422 race): it now exists.
        if (refCheckCount === 1) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify({ object: { sha: "existing-branch-sha" } }), { status: 200 });
      }
      if (url.includes("/git/ref/") && url.includes("main")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha-123" } }), { status: 200 });
      }
      if (init?.method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (init?.method === "POST" && url.endsWith("/git/refs")) {
        return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
      }
      if (init?.method === "GET" && url.includes("/contents/")) {
        return new Response("not found", { status: 404 });
      }
      if (init?.method === "PUT" && url.includes("/contents/")) {
        return new Response(
          JSON.stringify({ content: { sha: "abc123" }, commit: { sha: "commit-sha-abc123" } }),
          { status: 201 }
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as {
      data?: { branch: string };
      error?: string;
    };
    expect(result.error).toBeUndefined();
    expect(result.data?.branch).toBe("artifacts/pr-42");
    expect(refCheckCount).toBeGreaterThanOrEqual(2);
  });

  it("rejects a 422 branch-creation failure that is NOT the 'already exists' race", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/git/ref/") && url.includes("main")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha-123" } }), { status: 200 });
      }
      if (init?.method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (init?.method === "POST" && url.endsWith("/git/refs")) {
        // A validation/abuse 422 that is NOT the already-exists race.
        return new Response(JSON.stringify({ message: "Validation Failed" }), { status: 422 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { error?: string };
    expect(result.error).toContain("422");
    expect(result.error).toContain("Validation Failed");
  });

  it("rejects an 'already exists'-worded 422 if the ref cannot actually be verified afterward", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        // Always 404s, even on the post-422 verification GET -- the
        // "already exists" message was spurious/misleading.
        return new Response("not found", { status: 404 });
      }
      if (url.includes("/git/ref/") && url.includes("main")) {
        return new Response(JSON.stringify({ object: { sha: "base-sha-123" } }), { status: 200 });
      }
      if (init?.method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200 });
      }
      if (init?.method === "POST" && url.endsWith("/git/refs")) {
        return new Response(JSON.stringify({ message: "Reference already exists" }), { status: 422 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { error?: string };
    expect(result.error).toContain("422");
  });

  it("skips branch creation entirely when the artifact branch already exists", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        return new Response(JSON.stringify({ object: { sha: "existing-branch-sha" } }), { status: 200 });
      }
      if (init?.method === "POST" && url.endsWith("/git/refs")) {
        throw new Error("should not create a ref when the branch already exists");
      }
      if (init?.method === "GET" && url.includes("/contents/")) {
        return new Response("not found", { status: 404 });
      }
      if (init?.method === "PUT" && url.includes("/contents/")) {
        return new Response(
          JSON.stringify({ content: { sha: "abc123" }, commit: { sha: "commit-sha-abc123" } }),
          { status: 201 }
        );
      }
      return new Response("unexpected", { status: 500 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { data: { branch: string } };
    expect(result.data.branch).toBe("artifacts/pr-42");
  });

  it("never calls the pull request head/base/merge endpoints", async () => {
    const { fetchImpl } = newBranchFetchImpl();
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    await githubUploadPullRequestAssetToolSpec.perform(exec);

    const urls = (fetchImpl.mock.calls as unknown as Array<[string]>).map(([url]) => url);
    expect(urls.every((url) => !/\/pulls\/\d+(\/|$)/.test(url))).toBe(true);
  });

  it("uses the non-image markdown form for non-image files", async () => {
    const { fetchImpl } = newBranchFetchImpl();
    const exec = execution("tok", { ...baseParams, fileName: "log.txt" }, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { data: { markdown: string } };
    expect(result.data.markdown).toBe(
      "[log.txt](https://github.com/acme/widgets/blob/commit-sha-abc123/pr-42/log.txt?raw=true)"
    );
  });

  it("includes the existing file's sha on update instead of duplicating", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        // Artifact branch already exists.
        return new Response(JSON.stringify({ object: { sha: "existing-branch-sha" } }), { status: 200 });
      }
      if (init?.method === "GET" && url.includes("/contents/")) {
        return new Response(JSON.stringify({ sha: "existing-sha" }), { status: 200 });
      }
      if (init?.method === "PUT" && url.includes("/contents/")) {
        const body = JSON.parse(init!.body as string);
        expect(body.sha).toBe("existing-sha");
        return new Response(JSON.stringify({ content: { sha: "new-sha" }, commit: { sha: "commit-sha-new" } }), { status: 200 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { data: { branch: string } };
    expect(result.data.branch).toBe("artifacts/pr-42");
  });

  it("errors when the PUT response omits a commit sha (cannot pin the markdown to a durable commit)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        return new Response(JSON.stringify({ object: { sha: "existing-branch-sha" } }), { status: 200 });
      }
      if (init?.method === "GET" && url.includes("/contents/")) return new Response("not found", { status: 404 });
      if (init?.method === "PUT" && url.includes("/contents/")) {
        return new Response(JSON.stringify({ content: { sha: "abc123" } }), { status: 201 });
      }
      return new Response("unexpected", { status: 500 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { error?: string };
    expect(result.error).toContain("commit SHA");
  });

  it("returns a generic error on network failure without leaking the token", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        return new Response(JSON.stringify({ object: { sha: "existing-branch-sha" } }), { status: 200 });
      }
      if (init?.method === "GET" && url.includes("/contents/")) return new Response("not found", { status: 404 });
      throw new Error("boom super-secret-token");
    });
    const exec = execution("super-secret-token", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { error: string };
    expect(result.error).toBe("GitHub API request failed before a response was received.");
  });

  it("surfaces the GitHub API error message on a non-OK PUT response", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/git/ref/") && url.includes("artifacts")) {
        return new Response(JSON.stringify({ object: { sha: "existing-branch-sha" } }), { status: 200 });
      }
      if (init?.method === "GET" && url.includes("/contents/")) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
    });
    const exec = execution("tok", baseParams, buildCtx(fetchImpl as never));
    const result = (await githubUploadPullRequestAssetToolSpec.perform(exec)) as { error: string };
    expect(result.error).toContain("401");
    expect(result.error).toContain("Bad credentials");
  });

  it("logs activity metadata without leaking the token", async () => {
    const { fetchImpl } = newBranchFetchImpl();
    const activityLog = vi.fn(async () => {});
    const exec = execution("super-secret-token", baseParams, buildCtx(fetchImpl as never, activityLog));
    await githubUploadPullRequestAssetToolSpec.perform(exec);
    const loggedCall = (activityLog.mock.calls as unknown as Array<[{ metadata: { agentId: string; branch: string } }]>)[0][0];
    expect(JSON.stringify(loggedCall)).not.toContain("super-secret-token");
    expect(loggedCall.metadata.branch).toBe("artifacts/pr-42");
    expect(loggedCall.metadata.agentId).toBe("agent-1");
  });
});
