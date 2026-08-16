---
name: copilot-review
description: Run Copilot CLI review in a disposable repository copy.
version: 1.1.0
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

- The target is a Git repository whose review candidate is committed.
- GitHub Copilot CLI is installed and authenticated in the agent runtime. This is not guaranteed in Paperclip or Coder workspaces; the skill detects and reports an unavailable CLI rather than installing software or falling back to a different reviewer.
- The execution environment can run shell commands from the repository root.

## Procedure

1. Resolve the repository root with `git rev-parse --show-toplevel`. Stop with the exact error if the target is not a Git repository.
2. Confirm `copilot` is installed with `command -v copilot`. If it is missing, report `Copilot CLI is unavailable in this agent runtime` and stop. Do not install packages, use `npx`, or silently substitute another reviewer. If authentication fails, preserve the exact error and suggest `copilot login`.
3. Require a clean working tree. If `git status --porcelain` is non-empty, stop and ask the caller to commit or stash the candidate. A disposable clone cannot faithfully preserve every untracked, ignored, or partially staged state.
4. Create a temporary directory outside the repository and clone the current repository into it with `git clone --no-hardlinks --no-local`. Check out the exact source `HEAD` in detached mode and verify the disposable checkout's `HEAD` matches it. Register cleanup before invoking Copilot.
5. Run Copilot's built-in review agent from the **disposable checkout**, never the source repository:

```bash
copilot --reasoning-effort medium -p "/review" --silent --no-ask-user \
  --deny-tool='write' \
  --allow-tool='shell(git status)' \
  --allow-tool='shell(git diff)' \
  --allow-tool='shell(git log)' \
  --allow-tool='shell(git rev-parse)' \
  --allow-tool='shell(git show)'
```

Use the execution tool's working-directory option. Allow up to ten minutes. Keep medium reasoning unless the user explicitly requests another level. The shell allowlist is defense in depth only: Git options can write files, so isolation comes from the disposable checkout.

6. Remove the disposable checkout after Copilot exits, whether it succeeded or failed. Verify the source repository's `HEAD` and status are unchanged.
7. Return unique actionable findings first, ordered by severity, with file and line references. Say explicitly when Copilot reports no issues. Preserve any invocation error verbatim.

## Pitfalls

- Copilot CLI `/review` is the closest local analogue to hosted Copilot review, but it is not bit-for-bit identical.
- Tool denial alone is not a write boundary: permitted `git diff`, `git log`, and `git show` options can write output files. Always use the disposable checkout.
- Do not use `git worktree` for isolation; it shares repository metadata with the source checkout.
- Coder and other minimal Paperclip images may not contain Copilot CLI or its authentication. That is an explicit unavailable-reviewer result, not permission to install dependencies at runtime.
- Do not treat a clean review as proof that the change is correct.
- Do not post the findings to GitHub unless the user separately asks.

## Verification

Confirm Copilot ran in a disposable clone at the exact source `HEAD`, the clone was removed, the source repository was unchanged, and the response clearly distinguishes actionable findings from a clean result or invocation failure.
