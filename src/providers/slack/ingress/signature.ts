import { createHmac, timingSafeEqual } from "node:crypto";

// Slack's documented request-signing scheme:
// https://api.slack.com/authentication/verifying-requests-from-slack
//
// basestring = "v0:" + timestamp + ":" + rawBody
// signature  = "v0=" + hex(HMAC-SHA256(signingSecret, basestring))
//
// This module verifies the signature and the replay window BEFORE any JSON
// parsing happens (the caller must pass the untouched raw body string) — per
// DRO-975's acceptance criteria and openwiki/domain/slack-provider-design.md
// §T5, an attacker who can reach the ingress endpoint without a valid
// signature must never have the body parsed/trusted at all.

const SIGNATURE_VERSION = "v0";
const REPLAY_WINDOW_SECONDS = 300; // 5 minutes, per Slack's documented tolerance.

export interface VerifySlackSignatureInput {
  readonly signingSecret: string;
  readonly rawBody: string;
  readonly timestampHeader: string | undefined;
  readonly signatureHeader: string | undefined;
  // Injectable for deterministic tests; defaults to the real current time.
  // Never uses `Date.now()` implicitly at module scope so this stays pure.
  readonly nowEpochSeconds: number;
}

export type VerifySlackSignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export function verifySlackSignature(input: VerifySlackSignatureInput): VerifySlackSignatureResult {
  const { signingSecret, rawBody, timestampHeader, signatureHeader, nowEpochSeconds } = input;

  if (!timestampHeader || !timestampHeader.trim()) {
    return { ok: false, error: "Missing X-Slack-Request-Timestamp header" };
  }
  if (!signatureHeader || !signatureHeader.trim()) {
    return { ok: false, error: "Missing X-Slack-Signature header" };
  }
  if (!signatureHeader.startsWith(`${SIGNATURE_VERSION}=`)) {
    return { ok: false, error: "Unsupported Slack signature version" };
  }

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp) || String(timestamp) !== timestampHeader.trim()) {
    return { ok: false, error: "Malformed X-Slack-Request-Timestamp header" };
  }

  // Reject anything outside the documented ~5 minute replay window, in
  // either direction (stale OR suspiciously future-dated), before touching
  // the signature at all — this is a cheap, timing-irrelevant check.
  const age = Math.abs(nowEpochSeconds - timestamp);
  if (age > REPLAY_WINDOW_SECONDS) {
    return { ok: false, error: "Request timestamp is outside the 5-minute replay window" };
  }

  const basestring = `${SIGNATURE_VERSION}:${timestampHeader}:${rawBody}`;
  const expectedHex = createHmac("sha256", signingSecret).update(basestring, "utf8").digest("hex");
  const expectedSignature = `${SIGNATURE_VERSION}=${expectedHex}`;

  const expectedBuffer = Buffer.from(expectedSignature, "utf8");
  const actualBuffer = Buffer.from(signatureHeader, "utf8");

  // timingSafeEqual throws on length mismatch — compare lengths first (this
  // length check is not a timing side-channel: an attacker already knows the
  // expected signature length format from Slack's public documentation).
  if (expectedBuffer.length !== actualBuffer.length) {
    return { ok: false, error: "Invalid Slack signature" };
  }
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, error: "Invalid Slack signature" };
  }

  return { ok: true };
}
