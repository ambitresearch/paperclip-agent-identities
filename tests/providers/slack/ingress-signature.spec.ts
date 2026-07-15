import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifySlackSignature } from "../../../src/providers/slack/ingress/signature.js";

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5b1";

function sign(secret: string, timestamp: string, rawBody: string): string {
  const base = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", secret).update(base, "utf8").digest("hex");
  return `v0=${hmac}`;
}

function nowSeconds(): number {
  // Fixed reference instant for deterministic tests (no Date.now()/new Date()).
  return 1_800_000_000;
}

describe("verifySlackSignature", () => {
  const rawBody = JSON.stringify({ type: "event_callback" });

  it("accepts a valid signature within the timestamp window", () => {
    const timestamp = String(nowSeconds());
    const signature = sign(SIGNING_SECRET, timestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a signature with the wrong secret", () => {
    const timestamp = String(nowSeconds());
    const signature = sign("wrong-secret", timestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: signature,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/signature/i);
  });

  it("rejects a tampered body even with a signature computed for the original body", () => {
    const timestamp = String(nowSeconds());
    const signature = sign(SIGNING_SECRET, timestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody: rawBody + "x",
      timestampHeader: timestamp,
      signatureHeader: signature,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a timestamp older than 5 minutes (outside replay window)", () => {
    const staleTimestamp = String(nowSeconds() - 301);
    const signature = sign(SIGNING_SECRET, staleTimestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: staleTimestamp,
      signatureHeader: signature,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/timestamp/i);
  });

  it("rejects a timestamp from the future beyond the window", () => {
    const futureTimestamp = String(nowSeconds() + 301);
    const signature = sign(SIGNING_SECRET, futureTimestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: futureTimestamp,
      signatureHeader: signature,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a timestamp exactly at the 5-minute boundary", () => {
    const boundaryTimestamp = String(nowSeconds() - 300);
    const signature = sign(SIGNING_SECRET, boundaryTimestamp, rawBody);
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: boundaryTimestamp,
      signatureHeader: signature,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a missing signature header", () => {
    const timestamp = String(nowSeconds());
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: undefined,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing timestamp header", () => {
    const signature = sign(SIGNING_SECRET, String(nowSeconds()), rawBody);
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: undefined,
      signatureHeader: signature,
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed (non-numeric) timestamp header", () => {
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: "not-a-number",
      signatureHeader: "v0=deadbeef",
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature missing the v0= version prefix", () => {
    const timestamp = String(nowSeconds());
    const base = `v0:${timestamp}:${rawBody}`;
    const hmac = createHmac("sha256", SIGNING_SECRET).update(base, "utf8").digest("hex");
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: hmac, // no "v0=" prefix
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a signature of different length safely (constant-time compare)", () => {
    const timestamp = String(nowSeconds());
    const result = verifySlackSignature({
      signingSecret: SIGNING_SECRET,
      rawBody,
      timestampHeader: timestamp,
      signatureHeader: "v0=short",
      nowEpochSeconds: nowSeconds(),
    });
    expect(result.ok).toBe(false);
  });
});
