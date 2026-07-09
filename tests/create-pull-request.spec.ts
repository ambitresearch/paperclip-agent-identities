import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { CREDENTIAL_SIDECAR_PATH_ENV } from "../src/credential-sidecar.js";

describe("github_bot_create_pull_request tool", () => {
  const TEST_SECRET_ID = "00000000-0000-4000-8000-000000000001";
  const originalCredentialSidecarPath = process.env[CREDENTIAL_SIDECAR_PATH_ENV];
  let harness: ReturnType<typeof createTestHarness>;
  let credentialSidecarDir: string | null = null;

  beforeEach(async () => {
    credentialSidecarDir = await mkdtemp(join(tmpdir(), "agent-identities-pr-test-"));
    const sidecarPath = join(credentialSidecarDir, "credentials.json");
    process.env[CREDENTIAL_SIDECAR_PATH_ENV] = sidecarPath;
    await writeFile(sidecarPath, JSON.stringify({
      version: 1,
      identities: {
        "agent-1:github": { secretId: TEST_SECRET_ID }
      }
    }), "utf8");

    harness = createTestHarness({
      manifest,
      capabilities: [...manifest.capabilities, "events.emit"],
      config: {
        identities: {
          "agent-1": {
            label: "PR Bot",
            githubUsername: "paperclip-pr-bot"
          }
        }
      }
    });
    await plugin.definition.setup(harness.ctx);
  });

  afterEach(async () => {
    if (originalCredentialSidecarPath === undefined) {
      delete process.env[CREDENTIAL_SIDECAR_PATH_ENV];
    } else {
      process.env[CREDENTIAL_SIDECAR_PATH_ENV] = originalCredentialSidecarPath;
    }
    if (credentialSidecarDir) {
      await rm(credentialSidecarDir, { recursive: true, force: true });
      credentialSidecarDir = null;
    }
  });

  const validRunCtx = {
    provider: "github",
    agentId: "agent-1",
    runId: "run-1",
    companyId: "company-1",
    projectId: "project-1",
  };

  describe("parameter validation", () => {
    it("rejects missing repository", async () => {
      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { head: "feat", base: "main", title: "PR" },
        validRunCtx,
      );
      expect(result.error).toMatch(/repository is required/);
    });

    it("rejects missing head branch", async () => {
      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/repo", base: "main", title: "PR" },
        validRunCtx,
      );
      expect(result.error).toMatch(/head branch is required/);
    });

    it("rejects missing base branch", async () => {
      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/repo", head: "feat", title: "PR" },
        validRunCtx,
      );
      expect(result.error).toMatch(/base branch is required/);
    });

    it("rejects missing title", async () => {
      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/repo", head: "feat", base: "main" },
        validRunCtx,
      );
      expect(result.error).toMatch(/title is required/);
    });

    it("rejects null params", async () => {
      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        null,
        validRunCtx,
      );
      expect(result.error).toMatch(/params must be a non-null object/);
    });
  });

  describe("repository normalization", () => {
    it("allows valid repositories and leaves access decisions to GitHub", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("fake-token");
      const fetchSpy = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          number: 42,
          html_url: "https://github.com/paperclipai/paperclip/pull/42",
          state: "open",
          draft: false,
          head: { ref: "feat" },
          base: { ref: "main" },
        }), { status: 201 }),
      );

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "paperclipai/paperclip", head: "feat", base: "main", title: "PR" },
        validRunCtx,
      );

      expect(result.error).toBeUndefined();
      expect(result.data).toEqual(expect.objectContaining({ number: 42 }));
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.github.com/repos/paperclipai/paperclip/pulls",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("rejects malformed repository format before secret resolution", async () => {
      const secretsSpy = vi.spyOn(harness.ctx.secrets, "resolve");

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "not-a-valid-repo", head: "feat", base: "main", title: "PR" },
        validRunCtx,
      );
      expect(result.error).toMatch(/Invalid repository format/);
      expect(secretsSpy).not.toHaveBeenCalled();
    });
  });

  describe("successful PR creation", () => {
    it("creates a PR and returns URL/number", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("fake-token");
      vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          number: 7,
          html_url: "https://github.com/my-org/my-repo/pull/7",
          state: "open",
          draft: false,
          head: { ref: "feature-branch" },
          base: { ref: "main" },
        }), { status: 201 }),
      );

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        {
          repository: "my-org/my-repo",
          head: "feature-branch",
          base: "main",
          title: "Add new feature",
          body: "This PR adds a new feature",
          draft: false,
        },
        validRunCtx,
      );

      expect(result.error).toBeUndefined();
      expect(result.content).toContain("#7");
      expect(result.content).toContain("https://github.com/my-org/my-repo/pull/7");
      expect(result.data).toEqual({
        number: 7,
        url: "https://github.com/my-org/my-repo/pull/7",
        state: "open",
        draft: false,
        head: "feature-branch",
        base: "main",
      });
    });

    it("creates a draft PR", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("fake-token");
      const fetchSpy = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          number: 8,
          html_url: "https://github.com/my-org/my-repo/pull/8",
          state: "open",
          draft: true,
          head: { ref: "wip" },
          base: { ref: "main" },
        }), { status: 201 }),
      );

      await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        {
          repository: "my-org/my-repo",
          head: "wip",
          base: "main",
          title: "WIP: Draft PR",
          draft: true,
        },
        validRunCtx,
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(body.draft).toBe(true);
    });

    it("logs activity after PR creation", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("fake-token");
      vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          number: 10,
          html_url: "https://github.com/my-org/my-repo/pull/10",
          state: "open",
          draft: false,
          head: { ref: "feat" },
          base: { ref: "main" },
        }), { status: 201 }),
      );

      await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/my-repo", head: "feat", base: "main", title: "PR" },
        validRunCtx,
      );

      expect(harness.activity).toHaveLength(1);
      expect(harness.activity[0].message).toContain("Created PR #10");
      expect(harness.activity[0].metadata?.repository).toBe("my-org/my-repo");
    });

    it("normalizes full GitHub URL to canonical owner/repo for API call", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("fake-token");
      const fetchSpy = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          number: 11,
          html_url: "https://github.com/my-org/my-repo/pull/11",
          state: "open",
          draft: false,
          head: { ref: "feat" },
          base: { ref: "main" },
        }), { status: 201 }),
      );

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        {
          repository: "https://github.com/my-org/my-repo",
          head: "feat",
          base: "main",
          title: "PR via URL",
        },
        validRunCtx,
      );

      expect(result.error).toBeUndefined();
      // Verify the fetch was called with the canonical API URL
      const calledUrl = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toBe("https://api.github.com/repos/my-org/my-repo/pulls");
    });
  });

  describe("error handling", () => {
    it("returns error when secret resolution fails", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockRejectedValue(new Error("vault unavailable"));

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/my-repo", head: "feat", base: "main", title: "PR" },
        validRunCtx,
      );

      expect(result.error).toMatch(/Failed to resolve agent identity authentication credentials/);
      // Should NOT contain any token or secret details
      expect(result.error).not.toContain("vault");
    });

    it("returns error when GitHub API returns non-ok response", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("fake-token");
      vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          message: "Validation Failed",
          errors: [{ message: "No commits between main and main" }],
        }), { status: 422 }),
      );

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/my-repo", head: "feat", base: "main", title: "PR" },
        validRunCtx,
      );

      expect(result.error).toContain("Validation Failed");
      expect(result.error).toContain("No commits between main and main");
      // Token should never appear in error messages
      expect(result.error).not.toContain("fake-token");
    });

    it("returns error when fetch itself throws", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("fake-token");
      vi.spyOn(harness.ctx.http, "fetch").mockRejectedValue(new Error("network timeout"));

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/my-repo", head: "feat", base: "main", title: "PR" },
        validRunCtx,
      );

      expect(result.error).toMatch(/GitHub API request failed/);
      expect(result.error).not.toContain("fake-token");
      expect(result.error).not.toContain("network timeout");
    });
  });

  describe("token security", () => {
    it("never exposes token in successful response", async () => {
      vi.spyOn(harness.ctx.secrets, "resolve").mockResolvedValue("super-secret-token-xyz");
      vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
        new Response(JSON.stringify({
          number: 1,
          html_url: "https://github.com/my-org/r/pull/1",
          state: "open",
          draft: false,
          head: { ref: "h" },
          base: { ref: "b" },
        }), { status: 201 }),
      );

      const result = await harness.executeTool<ToolResult>(
        "github_bot_create_pull_request",
        { repository: "my-org/r", head: "h", base: "b", title: "T" },
        validRunCtx,
      );

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("super-secret-token-xyz");
    });
  });
});
