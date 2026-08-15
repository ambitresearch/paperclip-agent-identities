# GitHub Copilot PR review state model

Use this checklist for GitHub Copilot pull-request review rounds.

## State to inspect

- `pullRequest.headRefOid`: commit that needs review.
- `reviews.nodes`: select Copilot reviews by author login and compare each `commit.oid` to the head.
- `reviewThreads.nodes`: unresolved and outdated are independent flags; close addressed outdated threads too.
- `reviewRequests.nodes.requestedReviewer.__typename`: Copilot may appear as `Bot`, while the author appears as `User`.

## Correct sequence

1. Fix and push.
2. Reply to addressed comments.
3. Resolve addressed threads.
4. Verify unresolved count.
5. Request Copilot through GitHub's reviewer mechanism/UI.
6. Poll until a Copilot review exists for the exact current head.
7. If it has findings, repeat from step 1; if it has none, stop.

## Important distinction

Posting `@copilot review` in the conversation is not reliable evidence that GitHub queued a Copilot code review. Confirm a bot review request or ask the user to use the reviewer UI. Never report “Copilot review pending” solely from a mention comment.
