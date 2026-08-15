---
name: automated-pr-review-iteration
description: Iterate automated PR reviews to a clean current head.
version: 1.0.0
author: Roshan Gautam, Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [github, pull-requests, code-review, copilot, automation]
---

# Automated PR Review Iteration

Use this skill when a pull request must be revised repeatedly until an automated reviewer (for example GitHub Copilot) reviews the **current head** with no actionable findings.

## Core invariant

A review round is complete only when all of these are true:

1. every valid finding has been fixed and verified;
2. every addressed inline review thread has a reply and is resolved;
3. the next review was requested through the reviewer's supported request mechanism;
4. the review result being evaluated belongs to the current PR head commit.

Do not call a PR “waiting on the automated reviewer” while addressed threads remain unresolved or a human/self review request is still the visible blocker.

## Workflow

### 1. Inspect the real review state

Before changing code or polling, query all of the following:

- current PR head SHA;
- latest automated-review submission and its commit SHA;
- unresolved review threads, including outdated threads;
- current review requests and their GraphQL `__typename`;
- branch protection/check state.

Use GraphQL for review threads because REST comments alone do not expose the thread-resolution state. Treat `User`, `Team`, and `Bot` review requests as distinct principals.

### 2. Fix findings with TDD

For each actionable finding:

1. reproduce it with a focused failing test;
2. run the test and confirm the expected failure;
3. implement the smallest correct fix;
4. run focused tests, then the repository's full verification suite;
5. update affected documentation in the same change.

Check closely related call paths for the same defect class instead of patching only the reported line.

### 3. Close the review loop before requesting another round

After pushing a fix:

1. reply to every addressed inline comment with the fixing commit and concise behavior summary;
2. resolve every addressed thread, including outdated threads;
3. verify the unresolved-thread count is zero (or explicitly list threads intentionally left open);
4. only then request the next automated review.

An explanatory reply does **not** resolve its thread. Perform and verify the thread-resolution mutation separately.

### 4. Request the reviewer correctly

Do not assume a PR comment such as `@copilot review` is equivalent to requesting GitHub Copilot from the reviewer UI. The supported mechanism may be a bot review request represented as a `Bot` in `reviewRequests`.

If the API/CLI cannot create that bot review request reliably, do not fake success with a mention comment. Ask the user once to request the reviewer through GitHub's reviewer UI, then poll without altering review requests.

### 5. Poll without noise

While waiting:

- compare the automated review's `commit.oid` with the current head SHA;
- ignore old reviews even if they are the latest by timestamp for that author;
- stay silent when nothing changed;
- notify the user only for a pushed fix, completion, or an exact blocker requiring user action;
- after a new push, require a fresh review of that new head.

Stop polling only when the automated reviewer has reviewed the current head and produced zero actionable comments.

## GitHub GraphQL patterns

### Read thread and request state

Query `pullRequest.reviewThreads(first: 100)` for `id`, `isResolved`, `isOutdated`, and comments. Query `reviewRequests` with `requestedReviewer.__typename` plus user/team fields. Query recent reviews with `author.login`, `state`, `submittedAt`, and `commit.oid`.

### Resolve a thread

Use `resolveReviewThread(input: { threadId: $id })`, then re-query and verify `isResolved: true`. Batch all independently addressable thread IDs in one scripted loop, but verify the final unresolved count rather than trusting mutation responses alone.

## Pitfalls

- **Mention is not review request:** a comment can exist while no new automated review is queued.
- **Reply is not resolution:** addressed comments can continue blocking until their threads are resolved.
- **Old review is not current review:** always compare review commit SHA to PR head.
- **Outdated is not resolved:** outdated threads can remain unresolved and should be closed after their finding is addressed.
- **Self-request confusion:** a human review request can make the UI look like it is waiting on the author; inspect request principal types before reporting the blocker.
- **Do not manipulate requests while the user has just requested a review:** preserve the pending automated request and only poll it.
- **Do not merge:** iteration completion means a clean automated review, not permission to merge unless the user separately asks.

## Verification

Before declaring completion, verify zero unresolved threads and a clean automated review whose commit SHA equals the current head. Lead user-facing reports with those facts.

## References

- `references/github-copilot.md` — Copilot-specific state model and GraphQL checklist.
- `references/paperclip-bot-approval.md` — sanctioned Paperclip bot approval after a clean review.
