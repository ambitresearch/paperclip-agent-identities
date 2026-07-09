import { describe, expect, it } from "vitest";
import { normalizeGitHubRepoRef } from "../src/identity-policy.js";

describe("normalizeGitHubRepoRef", () => {
  it("normalizes GitHub repository references for provider API calls", () => {
    expect(normalizeGitHubRepoRef("my-org/my-repo")?.fullName).toBe("my-org/my-repo");
    expect(normalizeGitHubRepoRef("https://github.com/My-Org/My-Repo.git")?.fullName).toBe("my-org/my-repo");
    expect(normalizeGitHubRepoRef("git@github.com:My-Org/My-Repo.git")?.fullName).toBe("my-org/my-repo");
  });

  it("rejects malformed or non-GitHub repository references", () => {
    expect(normalizeGitHubRepoRef("")).toBeNull();
    expect(normalizeGitHubRepoRef("just-a-name")).toBeNull();
    expect(normalizeGitHubRepoRef("https://gitlab.com/my-org/my-repo")).toBeNull();
  });
});
