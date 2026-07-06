import { describe, expect, it, vi } from "vitest";
import { redactSecrets, redactSecretsInText, toSafeError } from "../src/lib/redaction.js";
import { createPullRequest } from "../src/lib/pr.js";
import { pushBranch } from "../src/lib/push.js";

describe("Redaction", () => {
  const fakeToken = "fake_token_123456";

  it("removes tokens from logs, errors, content, and activity payloads", async () => {
    const logLine = redactSecretsInText(`using token=${fakeToken}`, [fakeToken]);
    expect(logLine).not.toContain(fakeToken);

    const safeError = toSafeError(new Error(`request failed: ${fakeToken}`), [fakeToken]);
    expect(safeError.message).not.toContain(fakeToken);

    const payload = redactSecrets(
      {
        activity: { details: `pushed with ${fakeToken}` },
        logs: ["ok", `token ${fakeToken}`],
      },
      [fakeToken],
    );
    expect(JSON.stringify(payload)).not.toContain(fakeToken);

    const runner = {
      run: vi.fn().mockResolvedValue({
        code: 0,
        stdout: `created with ${fakeToken}`,
        stderr: `warn ${fakeToken}`,
      }),
    };
    const pushResult = await pushBranch(
      runner,
      { remote: "origin", branch: "feature/regression", token: fakeToken },
      [fakeToken],
    );
    expect(pushResult.stdout).not.toContain(fakeToken);
    expect(pushResult.stderr).not.toContain(fakeToken);

    const client = {
      createPullRequest: vi.fn().mockRejectedValue(new Error(`api rejected ${fakeToken}`)),
    };

    await expect(
      createPullRequest(
        client,
        {
          owner: "roshangautam",
          repo: "genie",
          title: "Regression hardening",
          body: "Body",
          head: "feature/regression",
          base: "main",
        },
        [fakeToken],
      ),
    ).rejects.toThrowError("[REDACTED]");

    await expect(
      createPullRequest(
        client,
        {
          owner: "roshangautam",
          repo: "genie",
          title: "Regression hardening",
          body: "Body",
          head: "feature/regression",
          base: "main",
        },
        [fakeToken],
      ),
    ).rejects.not.toThrowError(fakeToken);
  });
});

describe("Mocked GitHub API PR creation", () => {
  it("passes through successful PR creation", async () => {
    const client = {
      createPullRequest: vi.fn().mockResolvedValue({
        number: 42,
        url: "https://github.com/roshangautam/genie/pull/42",
      }),
    };

    const result = await createPullRequest(
      client,
      {
        owner: "roshangautam",
        repo: "genie",
        title: "Add tests",
        body: "This adds regression tests",
        head: "feature/tests",
        base: "main",
      },
      ["unused_test_token"],
    );

    expect(result.number).toBe(42);
    expect(client.createPullRequest).toHaveBeenCalledTimes(1);
  });
});

describe("Mocked subprocess push behavior", () => {
  it("uses git askpass with expected args and environment", async () => {
    const fakeToken = "fake_token_abc";
    const runner = {
      run: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
    };

    await pushBranch(runner, { remote: "origin", branch: "feature/branch", token: fakeToken }, [fakeToken]);

    expect(runner.run).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "HEAD:feature/branch"],
      expect.objectContaining({
        env: expect.objectContaining({
          GIT_ASKPASS: expect.stringContaining("paperclip-git-askpass-"),
          GIT_TERMINAL_PROMPT: "0",
        }),
      }),
    );
    const env = runner.run.mock.calls[0]?.[2]?.env as Record<string, string | undefined>;
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.PAPERCLIP_GIT_PUSH_TOKEN).toBeUndefined();
  });

  it("throws a redacted error when git push fails", async () => {
    const fakeToken = "fake_token_abc";
    const runner = {
      run: vi.fn().mockResolvedValue({
        code: 1,
        stdout: "",
        stderr: `authentication failed for ${fakeToken}`,
      }),
    };

    await expect(pushBranch(runner, { remote: "origin", branch: "feature/branch" }, [fakeToken])).rejects.toThrowError(
      "[REDACTED]",
    );
    await expect(pushBranch(runner, { remote: "origin", branch: "feature/branch" }, [fakeToken])).rejects.not.toThrowError(
      fakeToken,
    );
  });

  it("does not set askpass or token env when no token is provided", async () => {
    const runner = {
      run: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
    };

    await pushBranch(runner, { remote: "origin", branch: "feature/no-token" }, []);

    const env = runner.run.mock.calls[0]?.[2]?.env as Record<string, string | undefined>;
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.PAPERCLIP_GIT_PUSH_TOKEN).toBeUndefined();
  });
});
