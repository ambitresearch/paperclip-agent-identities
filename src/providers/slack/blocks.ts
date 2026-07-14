// Safe, static-only Slack Block Kit validation for the message-posting tools.
//
// openwiki/domain/slack-provider-mvp.md §6.1 (design record) originally scoped
// MVP message tools to plain text only, deferring "interactive components
// (buttons, modals, Block Kit forms) and arbitrary Block Kit/attachment
// payloads" as later work ("a later contract can add a validated
// static-block schema without changing the five tool names"). This module is
// that later, narrower contract: it accepts a small allow-listed set of
// purely-presentational block types and rejects anything with an
// action/interactive surface (buttons, selects, overflow menus, inputs,
// `accessory`/`action_id` fields, images) so a prompt-injected instruction
// cannot smuggle an interactive payload or an external image URL (potential
// exfiltration/tracking pixel) through this tool.
//
// Blocks are validated structurally (JSON-serializable plain objects only,
// bounded size, allow-listed keys) — never executed or introspected beyond
// that. Slack's own API is still the authority on any content restriction it
// enforces at `chat.postMessage` time.

const ALLOWED_BLOCK_TYPES = new Set(["section", "divider", "header", "context"]);
const ALLOWED_TEXT_TYPES = new Set(["mrkdwn", "plain_text"]);
const MAX_BLOCKS = 50;
const MAX_SERIALIZED_LENGTH = 40_000;
const MAX_TEXT_OBJECT_LENGTH = 3_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTextObject(value: unknown, path: string): string | null {
  if (!isPlainObject(value)) return `${path} must be an object`;
  const keys = Object.keys(value);
  const allowedKeys = new Set(["type", "text", "emoji", "verbatim"]);
  for (const key of keys) {
    if (!allowedKeys.has(key)) return `${path}.${key} is not allowed`;
  }
  if (typeof value.type !== "string" || !ALLOWED_TEXT_TYPES.has(value.type)) {
    return `${path}.type must be "mrkdwn" or "plain_text"`;
  }
  if (typeof value.text !== "string" || value.text.length === 0) {
    return `${path}.text must be a non-empty string`;
  }
  if (value.text.length > MAX_TEXT_OBJECT_LENGTH) {
    return `${path}.text exceeds ${MAX_TEXT_OBJECT_LENGTH} characters`;
  }
  if (value.emoji !== undefined && typeof value.emoji !== "boolean") {
    return `${path}.emoji must be a boolean`;
  }
  if (value.verbatim !== undefined && typeof value.verbatim !== "boolean") {
    return `${path}.verbatim must be a boolean`;
  }
  return null;
}

function validateBlock(value: unknown, index: number): string | null {
  const path = `blocks[${index}]`;
  if (!isPlainObject(value)) return `${path} must be an object`;

  const type = value.type;
  if (typeof type !== "string" || !ALLOWED_BLOCK_TYPES.has(type)) {
    return `${path}.type must be one of: ${[...ALLOWED_BLOCK_TYPES].join(", ")}`;
  }

  // Disallow any interactive/action surface outright, regardless of block
  // type -- these keys are never valid in the allow-listed static block
  // types above, but reject explicitly rather than silently ignoring them.
  const forbiddenKeys = ["accessory", "action_id", "elements", "fields", "image_url", "accessibility_label"];
  for (const key of forbiddenKeys) {
    if (key in value && !(type === "context" && key === "elements")) {
      return `${path}.${key} is not allowed`;
    }
  }

  if (type === "divider") {
    const allowedKeys = new Set(["type", "block_id"]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return `${path}.${key} is not allowed on a divider block`;
    }
    return null;
  }

  if (type === "header") {
    const allowedKeys = new Set(["type", "block_id", "text"]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return `${path}.${key} is not allowed on a header block`;
    }
    return validateTextObject(value.text, `${path}.text`);
  }

  if (type === "section") {
    const allowedKeys = new Set(["type", "block_id", "text"]);
    for (const key of Object.keys(value)) {
      if (!allowedKeys.has(key)) return `${path}.${key} is not allowed on a section block`;
    }
    return validateTextObject(value.text, `${path}.text`);
  }

  // context: only a bounded array of plain_text/mrkdwn text elements. No
  // images (avoids external-URL exfiltration/tracking-pixel surface).
  const elements = value.elements;
  const allowedKeys = new Set(["type", "block_id", "elements"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) return `${path}.${key} is not allowed on a context block`;
  }
  if (!Array.isArray(elements) || elements.length === 0) {
    return `${path}.elements must be a non-empty array`;
  }
  for (let i = 0; i < elements.length; i += 1) {
    const err = validateTextObject(elements[i], `${path}.elements[${i}]`);
    if (err) return err;
  }
  return null;
}

/**
 * Validates an optional Slack `blocks` parameter against the safe,
 * static-only allow-list described above. Returns `null` (no `blocks` field
 * at all is valid -- text-only messages remain the default) or the
 * normalized array on success, or an error string on rejection.
 */
export function validateSlackBlocks(input: unknown): { ok: true; blocks: unknown[] | undefined } | { ok: false; error: string } {
  if (input === undefined) return { ok: true, blocks: undefined };
  if (!Array.isArray(input)) return { ok: false, error: "blocks must be an array" };
  if (input.length === 0) return { ok: false, error: "blocks must not be empty when provided" };
  if (input.length > MAX_BLOCKS) return { ok: false, error: `blocks must not exceed ${MAX_BLOCKS} items` };

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, error: "blocks must be JSON-serializable" };
  }
  if (!serialized || serialized.length > MAX_SERIALIZED_LENGTH) {
    return { ok: false, error: `blocks exceeds the maximum serialized size of ${MAX_SERIALIZED_LENGTH} characters` };
  }

  for (let i = 0; i < input.length; i += 1) {
    const err = validateBlock(input[i], i);
    if (err) return { ok: false, error: err };
  }

  return { ok: true, blocks: input };
}
