---
name: code-review
description: Review PRs with available local agent reviewers.
version: 1.0.0
author: Roshan Gautam, Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [github, code-review, pull-requests, codex, claude]
---

# Code Review

Run a high-signal local review of a pull request or committed branch diff using the current agent runtime first, then optional external reviewer CLIs when they are already available. This skill does not require GitHub Copilot CLI and must not install, authenticate, or silently substitute tools.

## When to Use

Use when asked for a PR review, local review, Copilot-style review, Codex review, Claude review, or an independent review before opening or merging a pull request.

When running inside Paperclip with GitHub identity tools available, publish the completed review to GitHub as a pull request review. Do **not** put the review body or findings in Paperclip issue comments as the primary deliverable; Paperclip comments are only for operational blockers that prevent reaching GitHub.

Do not modify files or push branches. For normal PR review requests, submit a decisive GitHub review: use `APPROVE` when the PR has no verified merge-blocking concerns, use `REQUEST_CHANGES` when verified findings should block merge, and use `COMMENT` only when the caller explicitly asks for a non-decisive review or the evidence is insufficient to approve/request changes.

## Prerequisites

- The target is a Git repository whose review candidate is committed.
- The base ref for the candidate is known, such as the pull request base branch.
- The runtime can inspect the repository with normal file and shell tools.
- Optional reviewers may be present:
  - Codex CLI (`codex`) for a structured secondary review.
  - Claude Code (`claude`) for a structured secondary review.
  - GitHub Copilot CLI (`copilot`) for a best-effort extra opinion only.

Missing optional CLIs are normal in Paperclip and Coder workspaces. Report them as unavailable reviewers and continue with the reviewers that are available.

## Procedure

1. Resolve the repository root with `git rev-parse --show-toplevel`. Stop with the exact error if the target is not a Git repository.
2. Resolve `source-head = git rev-parse HEAD` and the candidate base ref. Prefer the pull request's actual base branch. Refuse an unknown or missing base instead of guessing.
3. Require a clean working tree before reviewing committed PR history. If `git status --porcelain` is non-empty, stop and ask the caller to commit or stash the candidate.
4. Gather baseline context with:
   - `git merge-base <base-ref> <source-head>`
   - `git diff --stat <base-ref>...<source-head>`
   - `git diff --name-status <base-ref>...<source-head>`
   - focused file diffs for changed files.
5. Run the default reviewer pass in the current agent runtime. Inspect the diff and relevant surrounding code. Focus on actionable defects introduced by the PR:
   - correctness and edge cases;
   - security and credential handling;
   - runtime/package compatibility;
   - tests and missing verification;
   - deployment and rollback safety;
   - documentation that would mislead operators.
6. Verify each candidate finding against code, tests, docs, or a focused command before reporting it. Drop unverified concerns, style-only nits, and anything not introduced by the candidate diff.
7. Optionally run external reviewers only when already available:
   - If `command -v codex` succeeds, run Codex in read-only review mode against the same base/head and capture its findings.
   - If `command -v claude` succeeds, run Claude Code in print mode with read-only file/shell permissions and capture its findings.
   - If `command -v copilot` succeeds, Copilot CLI may be run as an extra opinion in a disposable clone. If it is absent, record `Copilot CLI unavailable` and continue.
8. For every external finding, independently verify it in the current runtime before including it. A tool's confident wording is not evidence.
9. Deduplicate findings by root cause. Prefer the clearest file and line reference, not every place a symptom appears.
10. Compose a GitHub pull request review:
   - Use inline review comments for findings with precise changed-file line anchors.
   - Include a concise top-level review body with reviewer availability, verification evidence, and any non-inlineable findings.
   - Use `APPROVE` when no verified merge-blocking concerns remain.
   - Use `REQUEST_CHANGES` when verified findings should block merge.
   - Use `COMMENT` only when the caller explicitly asks for a non-decisive review or the evidence is insufficient to approve/request changes.
11. Publish the review to GitHub with `github_bot_submit_pull_request_review` when that tool is available. Include `repository`, `pullNumber`, `event`, `body`, and `comments`.
12. If `github_bot_submit_pull_request_review` is unavailable but another authenticated GitHub review path is explicitly available, use that path and disclose it. If no GitHub review path is available, stop with an operational blocker and do not substitute a Paperclip issue comment for the review.

## Optional reviewer commands

Codex, when available:

```bash
codex review --base <base-ref>
```

Claude Code, when available:

```bash
claude -p "Review this PR diff against <base-ref>. Report only verified actionable defects introduced by this PR." \
  --permission-mode plan \
  --allowedTools 'Read,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(git show *),Bash(git rev-parse *),Bash(git merge-base *),Bash(git grep *)' \
  --disallowedTools 'Edit,Write,WebSearch,WebFetch' \
  --max-turns 10 \
  --output-format json
```

Copilot CLI, when available, must remain optional. Run it only in an isolated disposable clone and preserve any policy/authentication blocker verbatim. Its absence must never fail the review.

## Pitfalls

- Publish the result as a GitHub pull request review, not as a Paperclip issue comment.
- Use the agent identity review tool (`github_bot_submit_pull_request_review`) when available so the review appears in GitHub's review timeline with inline comments.
- Do not leave a non-decisive COMMENT review by default. Approve clean PRs and request changes for verified blockers; reserve COMMENT for explicitly non-decisive or inconclusive reviews.
- If GitHub review submission fails, report the operational blocker in Paperclip instead of pretending the review was delivered.
- Do not make Copilot CLI a prerequisite. Paperclip and Coder runtimes often lack it.
- Do not install CLIs, use `npx`, or authenticate tools during review.
- Do not treat an external reviewer's finding as valid until you reproduce or verify it.
- Do not rely on `git diff` alone after `git reset --mixed`; untracked added files are invisible to plain `git diff`. Prefer reviewing committed `base...HEAD` directly for the default pass.
- Do not use a shell allowlist as a filesystem boundary for untrusted reviewer agents. Disposable clones reduce source checkout risk but are not OS sandboxes.
- Keep side effects separate. Reviewing is not posting, approving, pushing, or resolving threads.

## Verification

Before finishing, confirm:

- The exact base and head were recorded.
- The working tree was clean or the review stopped before proceeding.
- Each reported finding was verified against actual code or command output.
- Optional reviewer availability was disclosed.
- Missing Codex, Claude, or Copilot CLIs did not block the default review.
- The review was submitted to GitHub with `github_bot_submit_pull_request_review`, or a concrete GitHub-delivery blocker was recorded.
- Paperclip comments were not used as the primary review destination.
- No files or branches were changed by this skill.
