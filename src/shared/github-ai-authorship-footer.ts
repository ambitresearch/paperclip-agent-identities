// Shared footer appended to agent-authored issue/PR comments and descriptions
// so readers can tell content was posted by an AI agent via Paperclip. Kept
// as one module so every write-action tool (add-comment, update-issue, and
// any future comment/description writer) renders the same wording — a
// single source of truth rather than each tool string-templating its own.
export const AI_AUTHORSHIP_FOOTER =
  "\n\n---\n*This comment/description was posted by an AI agent via Paperclip.*";

/**
 * Appends the standard AI-authorship footer to a body of text. Only appends
 * when `body` is non-empty (after trimming) — never fabricates a
 * footer-only body from an empty/undefined string, since a bare footer with
 * no human-facing content is not a meaningful comment.
 */
export function appendAiAuthorshipFooter(body: string, llmModel?: string): string {
  if (!body || !body.trim()) {
    return body;
  }
  const modelLine = llmModel ? `\n*Model: ${llmModel}*` : "";
  return `${body}${AI_AUTHORSHIP_FOOTER}${modelLine}`;
}
