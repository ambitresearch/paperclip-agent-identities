---
name: copilot-review
description: Run Copilot CLI review on current repository changes.
version: 1.0.0
author: Roshan Gautam, Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [github, copilot, code-review, pull-requests]
---

# Copilot Review

Run GitHub Copilot CLI's built-in local code-review agent as an independent second opinion on the current repository changes.

## When to Use

Use when asked for a Copilot review, local Copilot review, Copilot-style PR review before opening or merging a PR, or a review from Copilot alongside another reviewer.

Do not use this skill to modify files, push changes, or post GitHub comments. It reports an independent review only.

## Prerequisites

- The target is a Git repository.
- GitHub Copilot CLI is installed and authenticated.
- The execution environment can run shell commands from the repository root.

## Procedure

1. Resolve the repository root with `git rev-parse --show-toplevel`. Stop with the exact error if the target is not a Git repository.
2. Confirm `copilot` is installed with `command -v copilot`. If it is missing, report that without installing anything. If authentication fails, preserve the exact error and suggest `copilot login`.
3. Run Copilot's built-in review agent from the repository root:

```bash
copilot --reasoning-effort medium -p "/review" --silent --no-ask-user \
  --deny-tool='write' \
  --allow-tool='shell(git status)' \
  --allow-tool='shell(git diff)' \
  --allow-tool='shell(git log)' \
  --allow-tool='shell(git rev-parse)' \
  --allow-tool='shell(git show)'
```

Use the execution tool's working-directory option instead of interpolating a path into the command. Allow up to five minutes. Keep medium reasoning unless the user explicitly requests another level.

4. Return unique actionable findings first, ordered by severity, with file and line references. Say explicitly when Copilot reports no issues. Preserve any invocation error verbatim.

## Pitfalls

- Copilot CLI `/review` is the closest local analogue to hosted Copilot review, but it is not bit-for-bit identical.
- Do not grant write access; the reviewer must remain independent.
- Do not treat a clean review as proof that the change is correct.
- Do not post the findings to GitHub unless the user separately asks.

## Verification

Confirm the command ran from the repository root, write access remained denied, and the response clearly distinguishes actionable findings from a clean result or invocation failure.
