import { describe, expect, it } from "vitest";
import { validateRepoPolicy, DEFAULT_BOT_IDENTITY_CONFIG } from "../src/shared/types.js";

describe("validateRepoPolicy", () => {
  const allowedOwner = DEFAULT_BOT_IDENTITY_CONFIG.allowedOwner;

  it("returns null for valid roshangautam/* repos", () => {
    expect(validateRepoPolicy("roshangautam/my-repo", allowedOwner)).toBeNull();
    expect(validateRepoPolicy("roshangautam/paperclip-plugin", allowedOwner)).toBeNull();
  });

  it("returns error for different owner", () => {
    const err = validateRepoPolicy("paperclipai/paperclip", allowedOwner);
    expect(err).toMatch(/repository owner must be "roshangautam"/);
  });

  it("returns error for empty string", () => {
    const err = validateRepoPolicy("", allowedOwner);
    expect(err).toMatch(/repository is required/);
  });

  it("returns error for missing slash", () => {
    const err = validateRepoPolicy("just-a-name", allowedOwner);
    expect(err).toMatch(/owner\/repo/);
  });

  it("returns error for too many slashes", () => {
    const err = validateRepoPolicy("a/b/c", allowedOwner);
    expect(err).toMatch(/owner\/repo/);
  });

  it("returns error for empty owner part", () => {
    const err = validateRepoPolicy("/repo", allowedOwner);
    expect(err).toMatch(/owner\/repo/);
  });

  it("returns error for empty repo part", () => {
    const err = validateRepoPolicy("roshangautam/", allowedOwner);
    expect(err).toMatch(/owner\/repo/);
  });
});
