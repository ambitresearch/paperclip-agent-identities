import { describe, it, expect } from "vitest";
import { normalizeGitHubRepoRef } from "../src/providers/github/repo-ref.js";

describe("normalizeGitHubRepoRef", () => {
  it("returns null for empty/whitespace input", () => {
    expect(normalizeGitHubRepoRef("")).toBeNull();
    expect(normalizeGitHubRepoRef("   ")).toBeNull();
  });

  it("parses an scp-style ssh remote and lowercases + strips .git", () => {
    expect(normalizeGitHubRepoRef("git@github.com:Octocat/Hello-World.git")).toEqual({
      kind: "github-repo",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
    });
  });

  it("parses an ssh:// url with a trailing slash", () => {
    expect(normalizeGitHubRepoRef("ssh://git@github.com/Octocat/Hello-World/")).toEqual({
      kind: "github-repo",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
    });
  });

  it("parses a git:// protocol url", () => {
    expect(normalizeGitHubRepoRef("git://github.com/Octocat/Hello-World.git")).toEqual({
      kind: "github-repo",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
    });
  });

  it("parses an https github url", () => {
    expect(normalizeGitHubRepoRef("https://github.com/Octocat/Hello-World")).toEqual({
      kind: "github-repo",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
    });
  });

  it("parses a bare github.com/owner/repo without a scheme", () => {
    expect(normalizeGitHubRepoRef("github.com/Octocat/Hello-World")).toEqual({
      kind: "github-repo",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
    });
  });

  it("parses a bare owner/repo pair", () => {
    expect(normalizeGitHubRepoRef("Octocat/Hello-World")).toEqual({
      kind: "github-repo",
      owner: "octocat",
      repo: "hello-world",
      fullName: "octocat/hello-world",
    });
  });

  it("returns null for a url-like ref on a non-github host", () => {
    expect(normalizeGitHubRepoRef("https://gitlab.com/octocat/hello-world")).toBeNull();
  });
});
