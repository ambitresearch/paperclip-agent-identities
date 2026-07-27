import { Ajv } from "ajv";
import addFormatsModule from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  EVENTS_REQUEST_URL_PATTERN,
  matchesEventsRequestUrlEnvelope,
} from "../../src/shared/events-request-url.js";

const addFormats = addFormatsModule.default;

const ajv = new Ajv();
addFormats(ajv);

/** RFC 3986 validation, as the config schema used to apply on top of the pattern. */
const matchesRfcUri = ajv.compile({ type: "string", format: "uri" });

/** WHATWG validation, as the manifest flow used to apply on top of the pattern. */
function parsesAsWhatwgUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

const BACKSLASH = String.fromCharCode(92);

describe("EVENTS_REQUEST_URL_PATTERN", () => {
  // This is the property that lets both call sites drop their own URL validator
  // and rely on the pattern alone. If it ever fails, the pattern has become
  // looser than one of the two validators and drift is possible again -- fix the
  // pattern rather than re-adding a check at a call site.
  it("accepts only values that both RFC 3986 and WHATWG accept", () => {
    const candidates: string[] = [];
    for (let code = 1; code < 128; code += 1) {
      const ch = String.fromCharCode(code);
      candidates.push(`https://a${ch}b.example.com/events`);
      candidates.push(`https://h.example.com/sl${ch}ack`);
      candidates.push(`https://a${ch}b.example.com`);
      candidates.push(`https://h.example.com:80${ch}/events`);
      // Bracketed IP-literals, where `[`, `]` and `:` are part of the host.
      candidates.push(`https://[2001:db8:${ch}:1]/events`);
      candidates.push(`https://[2001:db8::1]${ch}/events`);
      // A host whose final label is numeric makes WHATWG re-read the whole host
      // as IPv4 and throw, while RFC 3986 reads it as a `reg-name`.
      candidates.push(`https://a${ch}.1/events`);
      candidates.push(`https://1${ch}.2.3.4/events`);
    }

    const accepted = candidates.filter((value) => matchesEventsRequestUrlEnvelope(value));
    const divergent = accepted.filter(
      (value) => !matchesRfcUri(value) || !parsesAsWhatwgUrl(value),
    );

    // Guard against the sweep silently accepting nothing and passing vacuously.
    expect(accepted.length).toBeGreaterThan(100);
    expect(divergent).toEqual([]);
  });

  it.each([
    // Real production route the Settings UI derives.
    "https://paperclip.example.com/api/companies/company-1/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events",
    "https://paperclip-test.trycloudflare.com/events",
    "https://paperclip.example.com",
    "https://paperclip.example.com/",
    "https://paperclip.example.com:8443/events",
    "https://paperclip.example.com/a%20b",
    // IP-literal hosts: `URL.origin` keeps the brackets, so the URL this plugin
    // derives for such a deployment has to satisfy its own envelope.
    "https://[2001:db8::1]/events",
    "https://[2001:db8::1]:8443/events",
    "https://[::1]/events",
    "https://[::ffff:192.0.2.1]/events",
    "https://[2001:0db8:0000:0000:0000:0000:0000:0001]/events",
    "https://[2001:DB8::1]/events",
    "https://192.0.2.10:8443/events",
    "https://localhost/events",
    "https://paperclip.example.com./events",
    "https://1host.example.com/events",
  ])("accepts %s", (value) => {
    expect(matchesEventsRequestUrlEnvelope(value)).toBe(true);
  });

  it.each([
    // WHATWG normalizes each of these instead of throwing, so the old runtime
    // gate accepted them and shipped them verbatim to Slack while the config
    // schema rejected them.
    [`https://paperclip.example.com${BACKSLASH}events`, "backslash becomes a slash"],
    [`https://paperclip.example.com${BACKSLASH}${BACKSLASH}evil.example.com/events`, "authority spoof"],
    ["https://paperclip.example.com/a|b", "pipe is percent-encoded"],
    ["https://paperclip.example.com/a{b}", "braces are percent-encoded"],
    ["https://paperclip.example.com/a^b", "caret is percent-encoded"],
    ['https://paperclip.example.com/a"b', "quote is percent-encoded"],
    ["https://paperclip.example.com/a<b>", "angle brackets are percent-encoded"],
    ["https://paperclip.example.com/%zz", "malformed percent escape"],
    ["https://exámple.com/events", "non-ASCII host becomes punycode"],
    // RFC's `port = *DIGIT` has no bound, so the old schema accepted these while
    // the runtime `new URL()` threw.
    ["https://paperclip.example.com:99999/events", "port above 65535"],
    ["https://paperclip.example.com:notaport/events", "non-numeric port"],
    // Previously fixed drift, pinned so it cannot regress.
    ["https://user:pass@paperclip.example.com/events", "embedded credentials"],
    ["https://paperclip.example.com/sl ack", "interior whitespace"],
    ["https://paperclip.example.com/events?", "empty query delimiter"],
    ["https://paperclip.example.com/events#", "empty fragment delimiter"],
    ["http://paperclip.example.com/events", "not HTTPS"],
    ["not-a-url", "not a URL"],
    // RFC 3986 permits these two IP-literal forms; WHATWG rejects both, so
    // admitting them would break the containment property above.
    ["https://[fe80::1%25eth0]/events", "IPv6 zone identifier"],
    ["https://[v1.fe]/events", "IPvFuture literal"],
    ["https://[2001:db8::1/events", "unbalanced bracket"],
    ["https://[::::]/events", "malformed IPv6"],
    ["https://[1::2::3]/events", "two :: elisions"],
    ["https://[gggg::1]/events", "non-hex IPv6 group"],
    ["https://[2001:db8::1]extra/events", "trailing junk after IP-literal"],
    // Numeric final label: WHATWG re-reads the host as IPv4 and throws.
    ["https://a;.1/events", "numeric final label"],
    ["https://256.1.1.1/events", "octet above 255"],
  ])("rejects %s (%s)", (value) => {
    expect(matchesEventsRequestUrlEnvelope(value)).toBe(false);
  });

  it("stays usable as a JSON Schema pattern", () => {
    expect(() => ajv.compile({ type: "string", pattern: EVENTS_REQUEST_URL_PATTERN })).not.toThrow();
  });
});
