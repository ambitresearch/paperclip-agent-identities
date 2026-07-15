import { describe, it, expect, beforeEach } from "vitest";
import {
  isWithinSlackRateLimit,
  isWithinSlackUnauthenticatedRateLimit,
  resetSlackRateLimitState,
} from "../../../src/providers/slack/ingress/rate-limit.js";

describe("isWithinSlackRateLimit", () => {
  beforeEach(() => {
    resetSlackRateLimitState();
  });

  it("allows requests under the configured limit within a window", () => {
    const config = { limit: 3, windowMs: 1000 };
    expect(isWithinSlackRateLimit("team-a", 0, config)).toBe(true);
    expect(isWithinSlackRateLimit("team-a", 100, config)).toBe(true);
    expect(isWithinSlackRateLimit("team-a", 200, config)).toBe(true);
  });

  it("rejects requests once the limit is exceeded within the same window", () => {
    const config = { limit: 2, windowMs: 1000 };
    expect(isWithinSlackRateLimit("team-b", 0, config)).toBe(true);
    expect(isWithinSlackRateLimit("team-b", 10, config)).toBe(true);
    expect(isWithinSlackRateLimit("team-b", 20, config)).toBe(false);
  });

  it("resets the count once the window elapses", () => {
    const config = { limit: 1, windowMs: 100 };
    expect(isWithinSlackRateLimit("team-c", 0, config)).toBe(true);
    expect(isWithinSlackRateLimit("team-c", 50, config)).toBe(false);
    expect(isWithinSlackRateLimit("team-c", 101, config)).toBe(true);
  });

  it("tracks separate keys (teams) independently", () => {
    const config = { limit: 1, windowMs: 1000 };
    expect(isWithinSlackRateLimit("team-d", 0, config)).toBe(true);
    expect(isWithinSlackRateLimit("team-e", 0, config)).toBe(true);
    expect(isWithinSlackRateLimit("team-d", 10, config)).toBe(false);
    expect(isWithinSlackRateLimit("team-e", 10, config)).toBe(false);
  });

  it("uses a sane default config when none is supplied", () => {
    expect(isWithinSlackRateLimit("team-default", 0)).toBe(true);
  });

  it("caps unauthenticated ingress independently of any parsed team key", () => {
    for (let index = 0; index < 120; index += 1) {
      expect(isWithinSlackUnauthenticatedRateLimit(0)).toBe(true);
    }
    expect(isWithinSlackUnauthenticatedRateLimit(0)).toBe(false);
  });
});
