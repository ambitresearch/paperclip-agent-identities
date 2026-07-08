import { describe, expect, it } from "vitest";
import { validateRepoPolicy } from "../src/shared/types.js";

describe("validateRepoPolicy", () => {
  const allowedPatterns = ["roshangautam/*", "codestudiohq/laravel-totem"];

  it("returns null for repos matching owner/repo patterns", () => {
    expect(validateRepoPolicy("roshangautam/my-repo", allowedPatterns)).toBeNull();
    expect(validateRepoPolicy("codestudiohq/laravel-totem", allowedPatterns)).toBeNull();
  });

  it("returns error for non-matching repositories", () => {
    const err = validateRepoPolicy("paperclipai/paperclip", allowedPatterns);
    expect(err).toMatch(/does not match allowed repository patterns/);
  });

  it("returns error for empty string", () => {
    const err = validateRepoPolicy("", allowedPatterns);
    expect(err).toMatch(/repository is required/);
  });

  it("returns error for missing slash", () => {
    const err = validateRepoPolicy("just-a-name", allowedPatterns);
    expect(err).toMatch(/owner\/repo/);
  });

  it("returns error for too many slashes", () => {
    const err = validateRepoPolicy("a/b/c", allowedPatterns);
    expect(err).toMatch(/owner\/repo/);
  });

  it("returns error for empty owner part", () => {
    const err = validateRepoPolicy("/repo", allowedPatterns);
    expect(err).toMatch(/owner\/repo/);
  });

  it("returns error for empty repo part", () => {
    const err = validateRepoPolicy("roshangautam/", allowedPatterns);
    expect(err).toMatch(/owner\/repo/);
  });
});
