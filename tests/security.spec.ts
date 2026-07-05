import { describe, expect, it, vi } from "vitest";
import { normalizeGitHubRepo, isRepoAllowed } from "../src/lib/github.js";
import { resolveContributionAccess } from "../src/lib/access.js";
import { redactSecrets, redactSecretsInText, toSafeError } from "../src/lib/redaction.js";
import { createPullRequest } from "../src/lib/pr.js";
import { pushBranch } from "../src/lib/push.js";

describe("GitHub repository normalization", () => {
  it("normalizes HTTPS, SSH, .git suffix, and owner/repo input", () => {
    expect(normalizeGitHubRepo("https://github.com/RoshanGautam/Genie")).toBe("roshangautam/genie");
    expect(normalizeGitHubRepo("https://github.com/roshangautam/genie.git")).toBe("roshangautam/genie");
    expect(normalizeGitHubRepo("git@github.com:RoshanGautam/Genie.git")).toBe("roshangautam/genie");
    expect(normalizeGitHubRepo("roshangautam/genie")).toBe("roshangautam/genie");
  });

  it("rejects non-GitHub or malformed repository input", () => {
    expect(normalizeGitHubRepo("https://gitlab.com/roshangautam/genie")).toBeNull();
    expect(normalizeGitHubRepo("https://github.com/roshangautam")).toBeNull();
    expect(normalizeGitHubRepo("not-a-repo")).toBeNull();
  });
});

describe("Policy enforcement", () => {
  it("allows only the explicitly approved repository", () => {
    const allowed = ["roshangautam/genie"];

    expect(isRepoAllowed("roshangautam/genie", allowed)).toBe(true);
    expect(isRepoAllowed("paperclipai/paperclip", allowed)).toBe(false);
    expect(isRepoAllowed("affaan-m/everything-claude-code", allowed)).toBe(false);
    expect(isRepoAllowed("openai/plugins", allowed)).toBe(false);
    expect(isRepoAllowed("NousResearch/hermes-agent", allowed)).toBe(false);
  });

  it("supports owner wildcard entries while still denying other owners", () => {
    const allowed = ["roshangautam/*"];

    expect(isRepoAllowed("roshangautam/genie", allowed)).toBe(true);
    expect(isRepoAllowed("roshangautam/another-repo", allowed)).toBe(true);
    expect(isRepoAllowed("paperclipai/paperclip", allowed)).toBe(false);
  });

  it("matches owner wildcard entries case-insensitively across URL forms", () => {
    const allowed = ["RoshanGautam/*"];

    expect(isRepoAllowed("https://github.com/roshangautam/genie.git", allowed)).toBe(true);
    expect(isRepoAllowed("git@github.com:ROSHANGAUTAM/another-repo.git", allowed)).toBe(true);
    expect(isRepoAllowed("https://github.com/openai/plugins", allowed)).toBe(false);
  });
});

describe("Config resolution", () => {
  it("denies all contribution tools when identity is missing", () => {
    const result = resolveContributionAccess({}, { companyId: "paperclip" });

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("identity_missing");
    expect(result.deniedTools).toEqual(["github.push", "github.pr.create"]);
  });

  it("denies when company context is missing or wrong", () => {
    const config = {
      defaultIdentityAlias: "genie",
      identities: {
        genie: {
          companyId: "paperclip",
          githubUsername: "paperclip-genie",
          githubToken: "fake_token_for_tests",
        },
      },
    };

    const missingContext = resolveContributionAccess(config, {});
    expect(missingContext.allowed).toBe(false);
    expect(missingContext.reason).toBe("company_context_missing");

    const wrongContext = resolveContributionAccess(config, { companyId: "other-company" });
    expect(wrongContext.allowed).toBe(false);
    expect(wrongContext.reason).toBe("company_context_mismatch");
  });

  it("denies when company is not in allow list", () => {
    const config = {
      defaultIdentityAlias: "genie",
      identities: {
        genie: {
          companyId: "paperclip",
          githubUsername: "paperclip-genie",
          githubToken: "fake_token_for_tests",
        },
      },
      allowedCompanyIds: ["another-company"],
    };

    const result = resolveContributionAccess(config, { companyId: "paperclip" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("company_not_allowed");
    expect(result.reason).not.toBe("company_context_mismatch");
  });

  it("returns a fresh denied tools array for each denied result", () => {
    const first = resolveContributionAccess({}, { companyId: "paperclip" });
    const second = resolveContributionAccess({}, { companyId: "paperclip" });

    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);
    expect(first.deniedTools).not.toBe(second.deniedTools);
  });

  it("returns a frozen denied tools array", () => {
    const result = resolveContributionAccess({}, { companyId: "paperclip" });

    expect(result.allowed).toBe(false);
    expect(Object.isFrozen(result.deniedTools)).toBe(true);
  });
});

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
  it("uses git push with expected args and environment", async () => {
    const fakeToken = "fake_token_abc";
    const runner = {
      run: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
    };

    await pushBranch(runner, { remote: "origin", branch: "feature/branch", token: fakeToken }, [fakeToken]);

    expect(runner.run).toHaveBeenCalledWith(
      "git",
      ["push", "origin", "HEAD:feature/branch"],
      expect.objectContaining({ env: expect.objectContaining({ GITHUB_TOKEN: fakeToken }) }),
    );
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
});
