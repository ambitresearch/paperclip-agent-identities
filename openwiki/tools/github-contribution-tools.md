# GitHub contribution tools

The plugin exposes 25 GitHub-related agent tools. Tool metadata lives in shared definition files so `/src/manifest.ts` and `/src/worker.ts` use consistent names and schemas. Most of these tools mirror direct GitHub REST/GraphQL capabilities one-to-one; four are non-parity, plugin-specific tools with no direct GitHub equivalent: `github_bot_whoami` (identity self-check), `github_bot_push_branch` (mediated git push via the agent identity token), `github_bot_submit_pull_request_review` (the sanctioned review-submission path for this plugin's policies), and `github_bot_merge_pull_request` (the sanctioned merge path, with the review gate enforced server-side).

## Common safety pattern

For contribution tools, the intended order is:

1. validate tool parameters;
2. resolve the calling Paperclip agent's identity;
3. normalize repository inputs where applicable;
4. only then resolve credentials or mint a GitHub App installation token;
5. call GitHub or git;
6. redact secret material from returned process output or errors;
7. write activity logs with metadata but without tokens.

This order is covered across `/tests/create-pull-request.spec.ts`, `/tests/plugin.spec.ts`, and `/tests/security.spec.ts`. Preserve it when adding tools.

## `github_bot_whoami`

Source:

- metadata: `/src/shared/github-bot-whoami-tool.ts`
- implementation: inline in `/src/worker.ts`

Purpose: let an agent confirm which GitHub identity Paperclip resolved for the current tool run.

Schema: empty object, no additional properties.

Behavior:

- calls `resolveAgentIdentityFromPluginSettings(ctx, runCtx)`;
- fails closed for missing or invalid config;
- returns only safe metadata:
  - label
  - GitHub username
  - booleans for whether commit name/email are present
- does not return secret references, tokens, or sidecar paths.

`/tests/plugin.spec.ts` verifies safe output and missing-agent fail-closed behavior.

## `github_bot_create_pull_request`

Source:

- metadata: `/src/shared/github-bot-create-pull-request-tool.ts`
- implementation: `/src/providers/github/tools/create-pull-request.ts`

Purpose: create a GitHub pull request using the calling agent's configured identity.

Required parameters:

- `repository`: target repository, documented as `owner/repo` but implementation also accepts normalized GitHub URL forms.
- `head`: branch containing changes.
- `base`: branch to merge into.
- `title`: PR title.

Optional parameters:

- `body`
- `draft`
- `paperclipIssueId` for activity metadata
- `commit` / `remote` / `dryRun` (exact-commit publish, DRO-1173): when `commit` is provided, the tool
  publishes the local run's execution workspace HEAD (not the project's primary workspace -- see
  `resolveWorkspacePath` in `/src/providers/github/tools/push-branch.ts`, shared with
  `github_bot_push_branch`) at that exact commit before creating the PR, verifies the remote branch landed
  there, and rolls back a branch it just created if either the verification or the subsequent PR-creation
  call fails. `dryRun: true` is only meaningful together with `commit`; validation rejects `dryRun: true`
  without `commit` rather than silently ignoring it and creating a real PR.

Runtime behavior:

1. validates parameter types;
2. resolves the agent identity from instance config or settings state fallback;
3. normalizes `repository` to canonical GitHub owner/repo form;
4. resolves credentials just in time through `/src/credential-sidecar.ts`;
5. calls `POST https://api.github.com/repos/{owner}/{repo}/pulls` with the canonical normalized owner/repo;
6. logs a `pull_request` activity containing repository, PR number, URL, head/base, draft status, agent ID, and optional Paperclip issue ID;
7. returns PR number, URL, state, draft flag, head, and base.

Failure behavior:

- malformed params return direct validation errors;
- malformed repository inputs fail before secret resolution;
- credential resolution failures are logged internally and returned as a generic authentication error;
- network failures return a generic connectivity error;
- GitHub API non-OK responses return GitHub's message/errors when parseable.

Notable limitation from current source: `head` and `base` are only validated as strings, not as git ref names.

## `github_bot_push_branch`

Source:

- metadata: `/src/shared/github-bot-push-branch-tool-definition.ts`
- implementation: `/src/providers/github/tools/push-branch.ts`

Purpose: mediate pushing current workspace `HEAD` to a branch on a GitHub remote using the agent identity token.

Parameters:

- `branch` (required): destination branch/ref. The implementation pushes `HEAD:refs/heads/<branch>` unless the input already starts with `refs/heads/`.
- `remote` (optional): git remote name, default `origin`.
- `expectedRepository` (optional): `owner/repo` or GitHub URL that must match the resolved remote before pushing.
- `dryRun` (optional): when true, adds `--dry-run` to `git push`.
- `expectedCurrentSha` (optional): full 40-character hex commit SHA the caller believes is the branch's current remote tip. When set, the push runs as a ref-scoped `git push --force-with-lease=refs/heads/<branch>:<expectedCurrentSha>` instead of a plain push: this lets a reviewed, diverged branch be updated without raw git credentials, while still rejecting (not clobbering) the push if the remote's actual tip differs from what the caller expects. Rejected up front (before workspace resolution or credential resolution) unless it is exactly 40 hex characters — abbreviated SHAs and revision expressions (`HEAD~1`, `branch^`, etc.) are rejected so the lease target is always an unambiguous literal commit id. Omit this parameter for a normal, non-force push (the tool's default and recommended mode).

Runtime behavior:

1. validates params and rejects empty, whitespace-containing, NUL-containing, or dash-prefixed branch/remote values, and rejects an `expectedCurrentSha` that isn't exactly 40 hex characters — all before any workspace or credential resolution;
2. lists the invoking agent's issues without filtering by workflow status, omitting a blank runtime project filter, matches `runCtx.runId` against `executionRunId` or `checkoutRunId`, and uses that issue's execution workspace `cwd` (or `path`); this keeps isolated-worktree retries resolvable when an issue entered `blocked` before the new run, while still requiring the unique run ID match; when no usable execution workspace is available, it falls back to the matched issue's project ID and then to the runtime project ID before resolving that project's primary workspace;
3. runs `git remote get-url <remote>` in the workspace;
4. normalizes the remote URL to a GitHub owner/repo;
5. resolves the agent identity;
6. if `expectedRepository` is provided, normalizes it and requires exact match with the resolved remote;
7. resolves credentials just in time;
8. creates a temporary `GIT_ASKPASS` script and sets `GIT_TERMINAL_PROMPT=0` plus `GITHUB_TOKEN` in the child environment;
9. runs `git -c credential.helper= push [--dry-run] [--force-with-lease=refs/heads/{branch}:{expectedCurrentSha}] https://github.com/{owner}/{repo}.git HEAD:refs/heads/{branch}` — the `--force-with-lease` flag is only ever added, ref-scoped to the exact branch and SHA the caller supplied, when `expectedCurrentSha` was provided; there is no unguarded `--force`/`-f` code path;
10. redacts raw token, URL-encoded token, and basic-auth token forms from stdout/stderr and thrown errors;
11. cleans the temporary askpass directory in `finally`.

Activity logging captures outcomes such as invalid branch, missing workspace, remote resolution failure, unsupported remote, expected-repository mismatch, invalid `expectedCurrentSha`, credential failure, push failure, exception, and success — each carrying a `forceWithLease` flag when the push used the guarded lease. A push failure while `expectedCurrentSha` was set is tagged based on git's own output: it is reported as `push_failed_stale_lease` only when git's stderr contains its own `(stale info)` rejection line (the evidence of an actual diverged-tip rejection), and as the neutral `push_failed_force_with_lease` for any other leased-push failure (authentication, authorization, DNS, network, or another git error) — a leased push failure is never assumed to be a stale lease without that evidence. A non-leased push failure is reported as plain `push_failed`.

Failure behavior intentionally stops before credential resolution for unsupported remotes, malformed expected repositories, and expected-repository mismatches. GitHub App installation permissions decide whether a normalized GitHub repository is accessible. `/tests/plugin.spec.ts` covers these cases.

Notable limitation from current source: branch validation is conservative but does not call `git check-ref-format`, so unusual invalid refs may still reach `git push` and fail there.

## `github_bot_submit_pull_request_review`

Source:

- metadata: `/src/shared/github-bot-submit-pull-request-review-tool.ts`
- implementation: `/src/providers/github/tools/submit-pull-request-review.ts`

Purpose: submit a real GitHub App pull request review (`APPROVE`, `REQUEST_CHANGES`, or `COMMENT`) using the
calling agent's configured identity. This is the sanctioned path for routine PR review policy -- reviewers
must not bypass it with GitHub Sync, raw GitHub API calls, `gh`, or a stored personal token.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to review.
- `event`: one of `APPROVE`, `REQUEST_CHANGES`, `COMMENT`.

Optional parameters:

- `body`: overall review summary. Required unless `comments` is non-empty.
- `comments`: array of `{ path, line, body }` inline review comments anchored to the diff.
- `paperclipIssueId` for activity metadata.

Runtime behavior:

1. validates parameter types, including that each inline comment has a `path`, positive integer `line`, and `body`, and that `body` or at least one inline comment is present;
2. resolves the agent identity from instance config or settings state fallback;
3. normalizes `repository` to canonical GitHub owner/repo form before any credential is resolved;
4. resolves credentials just in time through `/src/credential-sidecar.ts`, minting a fresh per-agent GitHub App installation token for this call;
5. calls `POST https://api.github.com/repos/{owner}/{repo}/pulls/{pullNumber}/reviews` with `event`, optional `body`, and optional `comments`;
6. logs a `pull_request_review` activity containing repository, PR number, review ID, review URL, event, inline comment count, agent ID, and optional Paperclip issue ID;
7. returns the review ID, URL, state, and event.

Failure behavior:

- malformed params (missing repository/pullNumber/event, invalid event, malformed inline comments, missing body when no comments) return direct validation errors before any credential is resolved;
- malformed repository inputs fail before secret resolution;
- credential resolution failures are logged internally and returned as a generic authentication error;
- network failures return a generic connectivity error without leaking the token;
- GitHub API non-OK responses return GitHub's message/errors when parseable;
- repository access is scoped by the GitHub App installation's permissions -- a repository outside the installation's scope is rejected by the GitHub API itself.

`/tests/providers/github/submit-pull-request-review-tool.spec.ts` covers identity attribution (activity log
includes `agentId`, never the token), validation, repository-format fail-closed behavior, and GitHub API
success/failure paths.

## `github_bot_merge_pull_request`

Source:

- metadata: `/src/shared/github-bot-merge-pull-request-tool.ts`
- implementation: `/src/providers/github/tools/merge-pull-request.ts`

Purpose: merge a pull request using the agent's configured identity, so the agent chain can complete a
routine PR lifecycle end to end. Company policy assigns review *and* merge to agents, but before this tool
existed the plugin had no merge verb -- every approved agent PR turned into a board action at the last step,
or pushed the agent toward raw `gh`/direct API writes the same policy forbids.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to merge.

Optional parameters:

- `mergeMethod`: `merge`, `squash`, or `rebase`. Defaults to `squash`.
- `commitTitle` / `commitBody`: override the generated merge commit message.
- `expectedHeadSha`: full 40-character SHA the caller believes it reviewed. Mismatch refuses before the gate
  runs.
- `paperclipIssueId` for activity metadata.

### The merge gate

Unlike the other write wrappers, this one enforces policy server-side rather than trusting agent
self-discipline. `evaluateMergeGate` is a pure exported function -- it takes the observed pull request state
and returns every blocker at once (an agent with three problems learns all three from one call, instead of
discovering them one round-trip at a time). The merge endpoint is not called at all unless the gate passes.

A merge is refused when any of the following holds:

| Blocker code | Condition |
| --- | --- |
| `not_open` | the pull request is closed or already merged |
| `draft` | the pull request is still a draft |
| `caller_is_author` | the calling identity authored the pull request |
| `head_sha_mismatch` | `expectedHeadSha` no longer matches the current head |
| `not_mergeable` | `mergeable` is false or still being computed, or `mergeable_state` is not one of `clean` / `has_hooks` / `unstable` (so `dirty` conflicts, `behind` branches, and `blocked` branch protection all refuse) |
| `changes_requested` | a reviewer's latest review is `CHANGES_REQUESTED` |
| `insufficient_approvals` | fewer than `REQUIRED_NON_AUTHOR_APPROVALS` (2) approving reviews from distinct non-author reviewers, counted **on the current head commit** |
| `unresolved_review_threads` | any review thread is unresolved |
| `checks_not_passing` | checks are failing, or still running |

Approval counting deliberately mirrors GitHub's own semantics: only the latest decision per reviewer counts,
`COMMENT` reviews are ignored, `DISMISSED` clears a prior approval, and the author's self-approval never
counts toward the requirement. An approval submitted against an earlier commit is reported as *stale* and
does not count -- the refusal message names the stale approvers so the caller knows to re-request review
rather than guessing why a visibly-approved PR was refused.

`REQUIRED_NON_AUTHOR_APPROVALS` is a module constant, not a parameter. A caller able to pass
`requiredApprovals: 0` would turn the gate back into the honor system it exists to replace.

Two honest limitations, stated so nobody over-trusts the gate:

- **Model diversity is not enforced.** Policy calls for model-diverse approvals; the GitHub API does not
  expose which model authored a review. The gate verifies *distinct non-author reviewer identities* only.
  Model diversity remains a convention the reviewing agents must uphold themselves.
- **A repository with no CI is not blocked.** When GitHub reports zero check runs, workflow runs, and status
  contexts for the head commit, there is nothing pending to wait for, so the gate proceeds. The result
  reports `checksState: "none"` rather than `"success"` so the caller is never shown a green light it did not
  earn.

Runtime behavior:

1. validates parameter types (including that `expectedHeadSha`, when given, is a full 40-character hex SHA);
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. reads `GET .../pulls/{pullNumber}` for author, state, draft/merged flags, mergeability, and head SHA;
5. in parallel, reads all reviews (paginated), all review threads (GraphQL, paginated, unresolved count
   only), and the check/status/workflow-run fan-out for the head SHA -- reusing `computeAggregateState` from
   `github_bot_get_pull_request_checks` so both tools judge CI identically;
6. evaluates the gate; on refusal returns an `error` naming every blocker plus a `data` payload with the
   structured blocker list, approvers, stale approvers, unresolved thread count, and checks state -- and
   writes **no** activity log, because nothing was mutated;
7. on success calls `PUT .../pulls/{pullNumber}/merge` with `merge_method` and `sha` **pinned to the head the
   gate was evaluated against**, so a push that lands mid-gate makes GitHub reject with 409 rather than
   merging code no reviewer approved;
8. logs a `pull_request_merge` activity with repository, PR number, merge method, head SHA, merge commit SHA,
   base ref, approvers, checks state, agent ID, and optional Paperclip issue ID;
9. returns the merge commit SHA, base ref, approvers, and checks state.

Failure behavior mirrors the other GitHub tools: malformed params and repositories fail before credential
resolution; network failures return a generic connectivity error without leaking the token; non-OK GitHub
responses surface GitHub's message when parseable. A 409 additionally explains that the head moved after the
gate passed.

**Manifest permissions**: merging uses the existing `pull_requests: write` and `contents: write` grants and
requires no manifest change. The gate's check reads use the same `checks: read` / `statuses: read` /
`actions: read` permissions documented under `github_bot_get_pull_request_checks`.

`/tests/providers/github/merge-pull-request-tool.spec.ts` covers the pure gate exhaustively (each blocker,
latest-review-per-reviewer semantics, stale-approval detection, author self-approval exclusion, `[bot]`
login normalization, multi-blocker reporting) plus the wrapper itself: head-SHA pinning on the merge body,
proof the merge endpoint is never called when the gate refuses, 409 explanation, activity logging with agent
attribution and no token leakage, and GitHub API success/failure paths.

## `github_bot_get_pull_request_checks`

Source:

- metadata: `/src/shared/github-bot-get-pull-request-checks-tool.ts`
- implementation: `/src/providers/github/tools/get-pull-request-checks.ts`

Purpose: read-only visibility into a pull request's CI/CD status -- check runs (Actions and other Checks-API
integrations), legacy commit status contexts, and Actions workflow runs for the PR's head commit.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to inspect.

Runtime behavior:

1. validates parameter types;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `GET .../pulls/{pullNumber}` to resolve the head SHA;
5. calls, in parallel, `GET .../commits/{sha}/check-runs`, `GET .../commits/{sha}/status`, and
   `GET .../actions/runs?head_sha={sha}`;
6. returns the head SHA, the legacy overall commit status state, and normalized arrays of check runs,
   status contexts, and workflow runs.

Failure behavior mirrors the other GitHub tools: malformed params and repositories fail before credential
resolution; network failures return a generic connectivity error without leaking the token; non-OK GitHub
responses (including a 404 on the PR lookup itself) surface GitHub's message when parseable.

This tool is read-only -- it never mutates the pull request, a check, or a status.

`/tests/providers/github/get-pull-request-checks-tool.spec.ts` covers validation, repository-format
fail-closed behavior, the three-call fan-out keyed off the resolved head SHA, and GitHub API error surfacing.

## `github_bot_request_pull_request_reviewers`

Source:

- metadata: `/src/shared/github-bot-request-pull-request-reviewers-tool.ts`
- implementation: `/src/providers/github/tools/request-pull-request-reviewers.ts`

Purpose: request reviewers (users and/or teams) on a pull request using the agent's configured identity. This
is the sanctioned path for the agent-chain review routing described in company policy -- it must not be used
to request review from a human board user for routine PR gates.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to request reviewers on.

Optional parameters (at least one of `reviewers`/`teamReviewers` is required):

- `reviewers`: array of GitHub usernames.
- `teamReviewers`: array of team slugs (within the repository's organization).
- `paperclipIssueId` for activity metadata.

Runtime behavior:

1. validates parameter types, including that each array entry is a non-empty string and at least one of
   `reviewers`/`teamReviewers` is present;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `POST .../pulls/{pullNumber}/requested_reviewers` with `reviewers` and/or `team_reviewers`;
5. logs a `pull_request` activity containing repository, PR number, URL, requested reviewers/teams, agent
   ID, and optional Paperclip issue ID;
6. returns the PR number, URL, and the resulting requested reviewers/teams.

Failure behavior mirrors the other GitHub tools: malformed params and repositories fail before credential
resolution; network failures return a generic connectivity error without leaking the token; non-OK GitHub
responses (e.g. requesting a review from the PR author) surface GitHub's message when parseable.

**Manifest permissions**: `github_bot_get_pull_request_checks` reads Checks-API, commit-status, and
Actions workflow-run data (it calls `GET /repos/{owner}/{repo}/actions/runs` to resolve run
status/conclusion detail beyond what the Checks API alone exposes), which requires the App to hold
`checks: read`, `statuses: read`, and `actions: read` repository permissions in addition to the
existing `pull_requests`/`contents`/`issues`/`workflows` grants. `/src/providers/github/app-manifest.ts`'s
`createGitHubAppManifestFlow` now requests all three by default for *newly created* App manifests. As
documented in that file, this has no effect on an already-installed App -- existing installations must add
`checks:read`, `statuses:read`, and `actions:read` themselves (GitHub App settings -> Permissions & events)
before `github_bot_get_pull_request_checks` will succeed against them. `github_bot_request_pull_request_reviewers`
uses the existing `pull_requests: write` permission and requires no manifest change.

`/tests/providers/github/request-pull-request-reviewers-tool.spec.ts` covers validation, repository-format
fail-closed behavior, reviewers/team_reviewers request body construction, activity logging with agent
attribution and no token leakage, and GitHub API success/failure paths.

## `github_bot_get_issue_interaction_summary`

Source:

- metadata: `/src/shared/github-bot-get-issue-interaction-summary-tool.ts`
- implementation: `/src/providers/github/tools/get-issue-interaction-summary.ts`

Purpose: return a deterministic, sanitized summary of comment interactions recorded against a single
Paperclip issue, over a bounded window. This tool is **Paperclip-side only** -- it never calls the GitHub
API and requires no GitHub App credential (`requiresCredential: false`). It exists so an agent can reason
about "what has happened on this issue" without walking raw comment bodies (which may contain pasted
secrets) or paginating manually.

Required parameters:

- `issueId`: UUID of the Paperclip issue to summarise, scoped to the calling agent's company.

Optional parameters:

- `from`: ISO 8601 UTC start of the window, inclusive.
- `to`: ISO 8601 UTC end of the window, exclusive (`[from, to)`). When both `from` and `to` are given, the
  window must not exceed 30 days -- this keeps the tool a cheap bounded read rather than an unbounded export.

Runtime behavior:

1. validates parameter types and, when both `from`/`to` are present, that `to` is strictly after `from` and
   the window is at most 30 days;
2. loads the issue via `ctx.issues.get(issueId, companyId)`, returning an error if it does not exist in the
   calling agent's company (issue lookups are always company-scoped, so this cannot leak another company's
   issue);
3. loads all comments via `ctx.issues.listComments(issueId, companyId)`, drops soft-deleted comments, and
   filters to the `[from, to)` window;
4. sorts survivors ascending by `createdAt`, tie-broken by comment `id`, so repeated calls over the same
   window return interactions in the same order regardless of underlying storage ordering;
5. redacts each comment body for common secret shapes (GitHub PAT/App/OAuth token prefixes, OpenAI-style
   `sk-` keys, PEM private key blocks, `Bearer <token>`) and truncates the result to 280 characters;
6. logs an `issue` activity entry with the interaction count and the calling agent's ID (never comment
   bodies);
7. returns the issue's id/title/status, the resolved window, per-interaction records (`id`, author agent/user
   ID, `createdAt`, sanitized `bodyPreview`), and distinct-author counts.

Failure behavior: a non-existent issue or a comment-listing failure both return `{ error }` rather than
throwing; no GitHub API call is ever attempted, so there is no token to leak.

`/tests/providers/github/get-issue-interaction-summary-tool.spec.ts` covers window validation (bad dates,
`to <= from`, windows over 30 days), the missing-issue and listComments-failure paths, `[from, to)` boundary
filtering, soft-deleted-comment exclusion, deterministic ordering under duplicate timestamps, secret
redaction/truncation, and activity logging with agent attribution.

## `github_bot_upload_pull_request_asset`

Source:

- metadata: `/src/shared/github-bot-upload-pull-request-asset-tool.ts`
- implementation: `/src/providers/github/tools/upload-pull-request-asset.ts`

Purpose: upload an image, PDF, log, archive, or report file for a pull request and return a durable,
embeddable Markdown reference (`![...]` for images, `[...]` otherwise), **without ever touching the PR's
own head, base, or merge branch**. Every upload lands on a dedicated, per-PR, non-merge artifact branch
(`artifacts/pr-{pullNumber}`) that GitHub creates independently of the PR's branches.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number the asset belongs to (used only to namespace the artifact branch and
  path -- this tool never reads or writes the PR resource itself).
- `fileName`: the file name to store the asset under.
- `contentBase64`: base64-encoded file content.

Optional parameters:

- `mimeType`: used together with the file extension to decide whether the returned Markdown uses image
  (`![]`) or link (`[]`) syntax.
- `commitMessage`: overrides the default `Upload asset for PR #{pullNumber}: {fileName}` commit message.

Runtime behavior:

1. validates parameter types, including a strict single-path-segment `fileName` check (letters, digits, `.`,
   `_`, `-` only; no path separators or `..`) that rejects traversal attempts before any GitHub call;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. computes `branch = artifacts/pr-{pullNumber}` and `filePath = pr-{pullNumber}/{fileName}` -- both are
   derived only from `pullNumber`/`fileName`, never from the PR's actual head/base ref;
5. checks `GET .../git/ref/heads/{branch}` for the artifact branch. The Contents API can only write to a
   branch that already exists -- it does **not** create one -- so if the ref is missing, this tool resolves
   the repository's default branch and its HEAD SHA, then explicitly creates the artifact ref via
   `POST .../git/refs`. A `422` response to that create call is only treated as a benign concurrent-creation
   race if GitHub's message says the reference already exists **and** a follow-up `GET` on the ref confirms
   it now exists; any other `422` (GitHub also returns `422` for validation/abuse failures) or a failed
   verification is surfaced as an error instead of silently proceeding;
6. probes `GET .../contents/{filePath}?ref={branch}` to see whether the file already exists on that branch
   (to include its `sha` and update in place rather than fail on a duplicate-create);
7. calls `PUT .../contents/{filePath}` with `branch` set to the (now-confirmed-to-exist) artifact branch;
8. reads the `commit.sha` GitHub returns from that `PUT` and builds a **commit-pinned**
   `github.com/{owner}/{repo}/blob/{commitSha}/{filePath}?raw=true` URL (not a branch-relative URL, and not
   `raw.githubusercontent.com`, which is an unauthenticated domain that 404s for private repositories even
   for viewers with access -- the `github.com/.../blob/...?raw=true` form authenticates via the viewer's
   normal session/token and works for both public and private repos), so a later upload to the same file
   name never changes what a previously-shared Markdown reference renders. The tool also returns an
   `apiContentsUrl` (`api.github.com/repos/{owner}/{repo}/contents/{filePath}?ref={commitSha}`) for
   programmatic/bot consumers that hold an installation token. If the response omits a commit sha, the tool
   returns an error rather than a URL that isn't durable;
9. logs a `pull_request` activity entry with the artifact branch, commit sha, file name, and raw/API URLs
   (never the token);
10. returns the commit-pinned raw URL, API contents URL, branch, commit sha, file path, and Markdown snippet.

Failure behavior mirrors the other GitHub tools: malformed params and repositories fail before credential
resolution; a missing/null resolved token fails closed; network failures return a generic connectivity
error without leaking the token; non-OK GitHub responses on the ref-creation or `PUT` calls surface GitHub's
message when parseable.

**Never touches the PR's merge branch**: every request this tool makes targets `/repos/{owner}/{repo}/contents/{filePath}`
or `/repos/{owner}/{repo}/git/ref(s)/...`, and all of them are pinned to the `artifacts/pr-{pullNumber}`
branch (or, for branch creation, the default branch used only as the *base* SHA to fork from). It never
calls any `/pulls/{pullNumber}` endpoint (GET, PATCH, merge, or otherwise), so the PR's actual head branch,
base branch, and GitHub's synthetic merge ref are structurally unreachable from this code path.

`/tests/providers/github/upload-pull-request-asset-tool.spec.ts` covers validation (including path-traversal
rejection), fail-closed behavior on a missing token, explicit artifact-branch creation from the default
branch HEAD, the strict 422-race-vs-real-failure distinction (including a re-GET verification), that every
request URL and request body's `branch` field target only `artifacts/pr-{pullNumber}` (asserting no request
ever touches a `/pulls/` path or a `refs/pull/...` ref), image-vs-non-image Markdown selection, existing-file
`sha` reuse on update, commit-pinned URL construction (and the error path when no commit sha is returned),
and GitHub API success/failure paths including token-leakage checks on activity logs and error messages.

## `github_bot_add_issue_comment`

Source:

- metadata: `/src/shared/github-bot-add-issue-comment-tool.ts`
- implementation: `/src/providers/github/tools/add-issue-comment.ts`

Purpose: post a comment on a GitHub issue (or pull request, which GitHub treats as an issue for comments)
using the configured agent identity.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `issueNumber`: the issue (or pull request) number to comment on.
- `body`: the human-facing comment text.

Optional parameters:

- `llmModel`: model identifier included in the appended authorship footer.
- `paperclipIssueId` for activity metadata.

Runtime behavior:

1. validates parameter types, including that `body` is a non-empty (post-trim) string;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. appends an AI-authorship footer to `body` server-side (do not include your own authorship disclaimer);
5. calls `POST .../issues/{issueNumber}/comments` with the footer-appended body;
6. logs an `issue_comment` activity entry containing repository, issue number, comment ID/URL, agent ID,
   and optional Paperclip issue ID;
7. returns the comment ID and URL.

Failure behavior mirrors the other GitHub tools: malformed params and repositories fail before credential
resolution; network failures return a generic connectivity error without leaking the token; non-OK GitHub
responses surface GitHub's message when parseable.

`/tests/providers/github/add-issue-comment-tool.spec.ts` covers validation, repository-format fail-closed
behavior, authorship-footer application, activity logging with agent attribution and no token leakage, and
GitHub API success/failure paths.

## `github_bot_list_issue_comments`

Source:

- metadata: `/src/shared/github-bot-list-issue-comments-tool.ts`
- implementation: `/src/providers/github/tools/list-issue-comments.ts`

Purpose: list comments on a GitHub issue (or pull request) using the configured agent identity. Read-only.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `issueNumber`: the issue (or pull request) number to list comments for.

Optional parameters:

- `page`: page number (1-indexed), default 1.
- `perPage`: comments per page, up to 100, default 30.

Runtime behavior:

1. validates parameter types, including bounds on `page`/`perPage`;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `GET .../issues/{issueNumber}/comments?page={page}&per_page={perPage}`;
5. derives `hasMore` from the response `Link` header (`rel="next"`);
6. logs an `issue_comment_list` activity entry with repository, issue number, page, perPage, count, and
   agent ID (never comment bodies);
7. returns normalized comments (`id`, `author`, `body`, `createdAt`, `url`), page, perPage, and `hasMore`.

Failure behavior mirrors the other GitHub tools. This tool is read-only -- it never mutates a comment.

`/tests/providers/github/list-issue-comments-tool.spec.ts` covers validation, pagination bounds, `Link`
header-derived `hasMore`, and GitHub API success/failure paths.

## `github_bot_get_issue`

Source:

- metadata: `/src/shared/github-bot-get-issue-tool.ts`
- implementation: `/src/providers/github/tools/get-issue.ts`

Purpose: fetch a single GitHub issue's core fields (title, body, state, assignees, labels, milestone) using
the configured agent identity. Read-only.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `issueNumber`: the issue number to fetch.

Runtime behavior:

1. validates parameter types;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `GET .../issues/{issueNumber}`;
5. logs an `issue` activity entry with repository, issue number, and agent ID;
6. returns number, title, body, state, url, assignees, labels, and milestone (number/title, or `null`).

Note from current source: full linked-PR detection would require a second call against the issue timeline
events endpoint to find "cross-referenced"/"connected" events; this tool returns core issue fields only.

Failure behavior mirrors the other GitHub tools; this tool is read-only.

`/tests/providers/github/get-issue-tool.spec.ts` covers validation, repository-format fail-closed behavior,
field normalization (string vs. object label shapes), and GitHub API success/failure paths.

## `github_bot_update_issue`

Source:

- metadata: `/src/shared/github-bot-update-issue-tool.ts`
- implementation: `/src/providers/github/tools/update-issue.ts`

Purpose: update a GitHub issue's title, body, state, state reason, labels, assignees, or milestone using the
configured agent identity.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `issueNumber`: the issue number to update.

Optional parameters (at least one updatable field is required):

- `title`, `body` (AI-authorship footer appended when non-empty), `state` (`open`/`closed`), `stateReason`,
  `labels` (replacement array), `assignees` (replacement array), `milestone` (number or `null` to clear),
  `llmModel`, `paperclipIssueId`.

Runtime behavior:

1. validates parameter types, including that `labels`/`assignees` are string arrays, `milestone` is an
   integer or `null`, and that at least one updatable field is present;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. builds a partial PATCH body containing only the provided fields, appending the AI-authorship footer to
   `body` only when it is non-empty after trimming (an explicit empty-string `body` is sent as-is, clearing
   it without a footer);
5. calls `PATCH .../issues/{issueNumber}` with the partial body;
6. logs an `issue` activity entry with repository, issue number, agent ID, and optional Paperclip issue ID;
7. returns number, title, state, and url.

Failure behavior mirrors the other GitHub tools: malformed params/repositories fail before credential
resolution; missing-updatable-field is a validation error; non-OK GitHub responses surface GitHub's message.

`/tests/providers/github/update-issue-tool.spec.ts` covers validation (including the "at least one field"
requirement and milestone-clearing via `null`), authorship-footer application, partial-PATCH body
construction, activity logging, and GitHub API success/failure paths.

## `github_bot_get_pull_request`

Source:

- metadata: `/src/shared/github-bot-get-pull-request-tool.ts`
- implementation: `/src/providers/github/tools/get-pull-request.ts`

Purpose: fetch a single GitHub pull request's core fields (title, body, state, head/base branches, draft,
merged, mergeable state, requested reviewers) using the configured agent identity. Read-only.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to fetch.

Runtime behavior:

1. validates parameter types;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `GET .../pulls/{pullNumber}`;
5. logs a `pull_request` activity entry with repository, PR number, and agent ID;
6. returns number, title, body, state, url, draft, merged, mergeable, mergeableState, head ref, base ref,
   and requested reviewer logins.

Failure behavior mirrors the other GitHub tools; this tool is read-only.

`/tests/providers/github/get-pull-request-tool.spec.ts` covers validation, repository-format fail-closed
behavior, field normalization, and GitHub API success/failure paths.

## `github_bot_list_pull_request_files`

Source:

- metadata: `/src/shared/github-bot-list-pull-request-files-tool.ts`
- implementation: `/src/providers/github/tools/list-pull-request-files.ts`

Purpose: list the files changed in a GitHub pull request (filename, status, additions, deletions, changes,
and patch when available) using the configured agent identity. Read-only.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to list files for.

Optional parameters:

- `page`: page number (1-indexed), default 1.
- `perPage`: files per page, up to 100, default 30.

Runtime behavior:

1. validates parameter types, including bounds on `page`/`perPage`;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `GET .../pulls/{pullNumber}/files?page={page}&per_page={perPage}`;
5. derives `hasMore` from the response `Link` header (`rel="next"`);
6. logs a `pull_request_files` activity entry with repository, PR number, page, perPage, count, and agent ID;
7. returns normalized files (`filename`, `status`, `additions`, `deletions`, `changes`, `patch` or `null`),
   page, perPage, and `hasMore`.

Failure behavior mirrors the other GitHub tools; this tool is read-only.

`/tests/providers/github/list-pull-request-files-tool.spec.ts` covers validation, pagination bounds,
`Link` header-derived `hasMore`, and GitHub API success/failure paths.

## `github_bot_update_pull_request`

Source:

- metadata: `/src/shared/github-bot-update-pull-request-tool.ts`
- implementation: `/src/providers/github/tools/update-pull-request.ts`

Purpose: update a GitHub pull request's title, body, base branch, open/closed state, and/or draft/ready-for-
review state using the configured agent identity.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to update.

Optional parameters (at least one is required):

- `title`, `body` (AI-authorship footer appended server-side), `base` (retarget branch), `state`
  (`open`/`closed`), `draft` (boolean -- true converts to draft, false marks ready for review), `llmModel`,
  `paperclipIssueId`.

Runtime behavior:

1. validates parameter types and that at least one of `title`/`body`/`base`/`state`/`draft` is provided;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. builds a REST PATCH body from `title`/`body` (footer-appended)/`base`/`state` -- GitHub's REST
   `PATCH /pulls/{n}` endpoint does not accept a `draft` field;
5. calls `PATCH .../pulls/{pullNumber}` with that body;
6. if `draft` was requested and differs from the PATCH response's `draft` value, calls the GraphQL mutation
   `convertPullRequestToDraft` or `markPullRequestReadyForReview` (by the PR's GraphQL node ID) to toggle it,
   then re-fetches the PR via REST so the returned data reflects the post-toggle state;
7. logs a `pull_request` activity entry with repository, PR number, URL, state, draft, agent ID, and
   optional Paperclip issue ID;
8. returns number, url, state, draft, title, head ref, and base ref.

Failure behavior mirrors the other GitHub tools: malformed params/repositories fail before credential
resolution; a GraphQL draft-toggle failure or a post-toggle REST refetch failure is surfaced as an error
without leaking the token.

`/tests/providers/github/update-pull-request-tool.spec.ts` covers validation (including the "at least one
field" requirement), REST PATCH body construction, the REST-then-GraphQL draft-toggle sequencing and
post-toggle refetch, activity logging, and GitHub API success/failure paths.

## `github_bot_list_pull_request_review_threads`

Source:

- metadata: `/src/shared/github-bot-list-pull-request-review-threads-tool.ts`
- implementation: `/src/providers/github/tools/list-pull-request-review-threads.ts`

Purpose: list a pull request's review threads (file paths, inline comments, and resolution state) using the
configured agent identity, via the GitHub GraphQL API. Read-only -- does not mutate any thread.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `pullNumber`: the pull request number to inspect.

Optional parameters:

- `first`: maximum number of review threads to return (default 50, max 100, clamped rather than rejected
  above the max).

Runtime behavior:

1. validates parameter types and the `first` bound;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. runs a single GraphQL query for `repository.pullRequest.reviewThreads` (up to `first` threads), with each
   thread's `comments` capped at 50 nested comments per thread;
5. returns an error if the PR is not found or not accessible to this installation;
6. logs a `pull_request_review_threads` activity entry with repository, PR number, count, and agent ID;
7. returns each thread's `id`, `isResolved`, `isOutdated`, `path`, `line`, `startLine`, `diffSide`, and its
   comments (`id`, `url`, `body`, `author`, `createdAt`).

Failure behavior mirrors the other GitHub tools; this tool is read-only.

`/tests/providers/github/list-pull-request-review-threads-tool.spec.ts` covers validation and `first`
clamping, the missing/inaccessible-PR error path, comment/thread field normalization, and GraphQL
success/failure paths.

## `github_bot_reply_to_review_thread`

Source:

- metadata: `/src/shared/github-bot-reply-to-review-thread-tool.ts`
- implementation: `/src/providers/github/tools/reply-to-review-thread.ts`

Purpose: reply to an existing GitHub pull request review thread (a threaded inline review comment) using the
configured agent identity, via the GitHub GraphQL API.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `reviewThreadId`: the GraphQL node ID of the review thread to reply to (from
  `github_bot_list_pull_request_review_threads`).
- `body`: the human-facing reply text.

Optional parameters:

- `llmModel`, `paperclipIssueId`.

Runtime behavior:

1. validates parameter types, including that `body` is a non-empty (post-trim) string;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. appends an AI-authorship footer to `body` server-side;
5. calls the GraphQL mutation `addPullRequestReviewThreadReply` with the footer-appended body;
6. logs a `review_thread_reply` activity entry with repository, thread ID, comment ID/URL, agent ID, and
   optional Paperclip issue ID;
7. returns the new comment's ID and URL.

Failure behavior mirrors the other GitHub tools; GraphQL errors are surfaced without leaking the token.

`/tests/providers/github/reply-to-review-thread-tool.spec.ts` covers validation, authorship-footer
application, activity logging, and GraphQL success/failure paths.

## `github_bot_resolve_review_thread`

Source:

- metadata: `/src/shared/github-bot-resolve-review-thread-tool.ts`
- implementation: `/src/providers/github/tools/resolve-review-thread.ts`

Purpose: mark a GitHub pull request review thread as resolved using the configured agent identity, via the
GitHub GraphQL API.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `reviewThreadId`: the GraphQL node ID of the review thread to resolve.

Optional parameters:

- `paperclipIssueId`.

Runtime behavior:

1. validates parameter types;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. verifies via GraphQL that `reviewThreadId` actually belongs to the requested `repository` -- review
   thread node IDs are global and not scoped to a repository by GitHub, so without this check a caller
   could pass a thread ID from a different repo and have it resolved while the tool reports/logs it against
   `repository`; a mismatch or lookup failure is returned as an error and the mutation is never attempted;
5. calls the GraphQL mutation `resolveReviewThread`;
6. logs a `review_thread` activity entry with repository, thread ID, `isResolved`, agent ID, and optional
   Paperclip issue ID;
7. returns the thread's ID and `isResolved`.

Failure behavior mirrors the other GitHub tools; GraphQL errors are surfaced without leaking the token.

`/tests/providers/github/resolve-review-thread-tool.spec.ts` covers validation, cross-repository thread
rejection, activity logging, and GraphQL success/failure paths.

## `github_bot_unresolve_review_thread`

Source:

- metadata: `/src/shared/github-bot-unresolve-review-thread-tool.ts`
- implementation: `/src/providers/github/tools/unresolve-review-thread.ts`

Purpose: reopen (mark unresolved) a previously-resolved GitHub pull request review thread using the
configured agent identity, via the GitHub GraphQL API.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `reviewThreadId`: the GraphQL node ID of the review thread to unresolve.

Optional parameters:

- `paperclipIssueId`.

Runtime behavior mirrors `github_bot_resolve_review_thread`, calling the GraphQL mutation
`unresolveReviewThread` instead and logging a `review_thread` activity entry with the resulting
`isResolved: false`.

Failure behavior mirrors the other GitHub tools; GraphQL errors are surfaced without leaking the token.

`/tests/providers/github/unresolve-review-thread-tool.spec.ts` covers validation, activity logging, and
GraphQL success/failure paths.

## `github_bot_list_organization_projects`

Source:

- metadata: `/src/shared/github-bot-list-organization-projects-tool.ts`
- implementation: `/src/providers/github/tools/list-organization-projects.ts`

Purpose: list GitHub Projects v2 (org-level) for a GitHub organization using the configured agent identity,
optionally filtered by a search query, via the GitHub GraphQL API. Requires the GitHub App to have the
organization Projects permission granted and accepted for the target installation.

Required parameters:

- `organization`: GitHub organization login (e.g. `"my-org"`) -- this tool resolves an organization
  resource reference rather than a repository ref, since Projects v2 boards are org-scoped.

Optional parameters:

- `query`: search string to filter projects by title.
- `first`: maximum number of projects to return (default 20, max 100, clamped).

Runtime behavior:

1. validates parameter types and the `first` bound;
2. resolves the agent identity and normalizes/lowercases the organization login before any credential is
   resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. runs a GraphQL query for `organization.projectsV2` (up to `first` nodes, optionally filtered by `query`);
5. returns an error if the organization is not found or not accessible to this installation;
6. logs progress via `ctx.logger.info` only (no `ctx.activity.log` call for this read-only listing);
7. returns the organization login and an array of projects (`id`, `number`, `title`, `url`, `closed`,
   `public`).

Failure behavior mirrors the other GitHub tools; this tool is read-only.

`/tests/providers/github/list-organization-projects-tool.spec.ts` covers validation and `first` clamping,
the missing/inaccessible-organization error path, and GraphQL success/failure paths.

## `github_bot_add_pull_request_to_project`

Source:

- metadata: `/src/shared/github-bot-add-pull-request-to-project-tool.ts`
- implementation: `/src/providers/github/tools/add-pull-request-to-project.ts`

Purpose: add a pull request as an item on a GitHub Projects v2 (org-level) board using the configured agent
identity, via the GitHub GraphQL Projects v2 API. Requires the GitHub App to have the organization Projects
permission granted and accepted for the target installation.

Required parameters:

- `repository`: repository the pull request lives in, `owner/repo` (also accepts normalized GitHub URL
  forms).
- `pullNumber`: the pull request number to add to the project.
- `projectId`: the Projects v2 node ID (from `github_bot_list_organization_projects`) to add the pull
  request to.

Runtime behavior:

1. validates parameter types;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. runs a GraphQL query to resolve the pull request's GraphQL node ID, returning an error if the PR is not
   found;
5. runs the GraphQL mutation `addProjectV2ItemById` with that node ID and the given `projectId`, returning an
   error if GitHub does not return a project item;
6. logs a `pull_request` activity entry with repository, PR number/URL, project ID, project item ID, and
   agent ID;
7. returns repository, PR number/URL, project ID, and project item ID.

Failure behavior mirrors the other GitHub tools: the PR-lookup and item-add GraphQL calls each surface their
own error message; a missing PR or a missing returned item are both treated as errors rather than silently
proceeding.

`/tests/providers/github/add-pull-request-to-project-tool.spec.ts` covers validation, the PR-lookup-then-add
two-call sequencing, missing-PR and missing-item error paths, activity logging, and GraphQL success/failure
paths.

## `github_bot_assign_to_current_user`

Source:

- metadata: `/src/shared/github-bot-assign-to-current-user-tool.ts`
- implementation: `/src/providers/github/tools/assign-to-current-user.ts`

Purpose: assign a GitHub issue or pull request to the calling agent's configured GitHub App installation
identity, preserving any existing assignees.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `issueNumber`: the issue (or pull request) number to assign.

Optional parameters:

- `paperclipIssueId`.

Security note: there is deliberately **no** `username`/`assignee` parameter. The only assignee this action
can ever produce is `execution.identity.identity.githubUsername` -- the value resolved from the per-agent
GitHub App identity config, never a caller-supplied string, an environment variable, or a
personal-access-token-associated account. This makes "assign to some other user" and "silently fall back to
a personal token's account" both structurally impossible rather than merely validated at runtime.

Runtime behavior:

1. validates parameter types;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `POST .../issues/{issueNumber}/assignees` with `assignees: [githubUsername]` -- this endpoint
   *adds* up to 10 assignees without removing existing ones, so "preserve existing assignees" falls out of
   the endpoint choice rather than a read-then-write against the current assignee list;
5. logs an `issue` activity entry with repository, issue number/URL, assignee, resulting assignees, agent
   ID, and optional Paperclip issue ID;
6. returns the issue number, url, and resulting assignee logins.

Failure behavior mirrors the other GitHub tools.

`/tests/providers/github/assign-to-current-user-tool.spec.ts` covers validation, the proof that the
assignee sent to GitHub is always and only the configured identity (no parameter can override it), activity
logging, and GitHub API success/failure paths.

## `github_bot_search_repository_items`

Source:

- metadata: `/src/shared/github-bot-search-repository-items-tool.ts`
- implementation: `/src/providers/github/tools/search-repository-items.ts`

Purpose: search issues or pull requests in a GitHub repository using the GitHub search API (for triage and
dedup workflows), using the configured agent identity. Read-only.

Required parameters:

- `repository`: target repository, `owner/repo` (also accepts normalized GitHub URL forms).
- `query`: search query string (e.g. `"bug label:critical"`), up to 256 characters.

Optional parameters:

- `type`: `"issue"` or `"pr"` (default `"issue"`).
- `maxResults`: results per page, 1-30 (default 10).
- `page`: page number, 1 to 34 (GitHub Search API caps results at 1000 total, i.e. 34 pages of 30).

Runtime behavior:

1. validates parameter types and bounds, including the 256-character query cap and the 1-34 page cap;
2. resolves the agent identity and normalizes `repository` before any credential is resolved;
3. resolves credentials just in time, minting a fresh per-agent GitHub App installation token;
4. calls `GET /search/issues` with the caller's `query` combined with a repository- and
   `type:issue`/`type:pr`-scoped qualifier (both URL-encoded together, so the caller cannot widen the search
   beyond the target repository by injecting its own `repo:` qualifier into `query`);
5. derives `hasMore` from `page * maxResults < total_count`;
6. logs a `repository` activity entry with repository, query, type, result count, and agent ID;
7. returns `totalCount`, `page`, `perPage`, `hasMore`, and normalized items (`number`, `title`, `state`,
   `url`, `labels`, `assignees`).

Failure behavior mirrors the other GitHub tools; this tool is read-only.

`/tests/providers/github/search-repository-items-tool.spec.ts` covers validation (query length, page/type/
maxResults bounds), the repo/type-scoped query construction, `hasMore` derivation, activity logging, and
GitHub API success/failure paths.

## `github_bot_link_github_item`

Source:

- metadata: `/src/shared/github-bot-link-github-item-tool.ts`
- implementation: `/src/providers/github/tools/link-github-item.ts`

Purpose: link a Paperclip issue to a GitHub issue or pull request URL, even when the target repository is
not mapped to a Paperclip project. This tool is **Paperclip-side only** -- it never calls the GitHub API and
requires no GitHub App credential (`requiresCredential: false`). The link is stored in Paperclip plugin
state, scoped to the Paperclip issue, independent of any project-repo mapping. Links are additive: linking
the same `githubUrl` again updates its recorded note/timestamp rather than creating a duplicate entry. Use
`github_bot_get_issue` or `github_bot_get_pull_request` separately to verify the target still exists on
GitHub.

Required parameters:

- `paperclipIssueId`: UUID of the Paperclip issue to link from.
- `githubUrl`: full GitHub URL of the issue or pull request to link to.

Optional parameters:

- `note`: free-text note describing why this link exists.
- `llmModel`: model identifier to include in activity metadata.

Runtime behavior:

1. validates parameter types, including that `githubUrl` parses as an absolute URL whose hostname is
   exactly `github.com` (case-insensitive) -- this rejects non-GitHub URLs and lookalike hosts before any
   state write;
2. persists the link via `persistGithubLink`, which is scoped to the calling agent's company and the given
   Paperclip issue;
3. logs an `issue` activity entry with the Paperclip issue ID, GitHub URL, agent ID, and optional model
   identifier;
4. returns the Paperclip issue ID, GitHub URL, recorded note, `linkedAt` timestamp, and total link count for
   that issue.

Failure behavior: a persistence failure returns `{ error }` rather than throwing; since no GitHub API call
is ever made, there is no token to leak and no GitHub-side authorization decides whether the link succeeds.

`/tests/providers/github/link-github-item-tool.spec.ts` covers `github.com`-hostname validation (including
rejection of non-GitHub and lookalike URLs), additive-link/update-on-relink behavior, persistence-failure
handling, and activity logging.

## Shared redaction and helper utilities

`/src/lib/redaction.ts` provides recursive redaction for strings, arrays, and objects, plus safe error conversion.

`/src/lib/push.ts` contains a lower-level push helper with similar askpass/redaction cleanup behavior. It removes inherited `GITHUB_TOKEN` and `PAPERCLIP_GIT_PUSH_TOKEN` from the child environment. This helper is tested by `/tests/security.spec.ts`; the currently registered mediated push tool has its own implementation in `/src/providers/github/tools/push-branch.ts`.

`/src/lib/pr.ts` wraps PR client errors with redaction. It is covered by security tests even though the registered PR tool currently calls `ctx.http.fetch` directly.

## Test map

- `/tests/create-pull-request.spec.ts`: PR validation, malformed repo before secrets, success path, draft flag, activity logging, canonical API URL, credential/API/fetch error behavior, no token leakage.
- `/tests/providers/github/submit-pull-request-review-tool.spec.ts`: review event/param validation, malformed inline comments, repository normalization before credentials, fail-closed on missing token, APPROVE/REQUEST_CHANGES/COMMENT success paths, activity logging with agent attribution and no token leakage, network/API failure handling.
- `/tests/providers/github/merge-pull-request-tool.spec.ts`: the pure merge gate (every blocker code, latest-review-per-reviewer semantics, stale-approval detection, author self-approval exclusion, `[bot]` login normalization, no-CI-signals handling, multi-blocker reporting) and the wrapper (param/merge-method validation, head-SHA pinning on the merge body, proof the merge endpoint is never called when the gate refuses, 409 head-moved explanation, activity logging with agent attribution and no token leakage, GitHub API success/failure paths).
- `/tests/plugin.spec.ts`: `whoami`, push success and denial paths, dry-run behavior, sidecar integration, redaction on push failure.
- `/tests/security.spec.ts`: generic redaction, PR helper redaction, push helper token handling and cleanup.
- `/tests/identity-policy.spec.ts`: identity and credential resolution used by all tools.
- `/tests/providers/github/get-issue-interaction-summary-tool.spec.ts`: Paperclip-side-only interaction summary -- window validation, missing-issue/listComments-failure handling, `[from, to)` filtering, soft-delete exclusion, deterministic ordering, secret redaction/truncation, activity logging.
- `/tests/providers/github/upload-pull-request-asset-tool.spec.ts`: PR asset upload -- validation, fail-closed on missing token, proof that every request/branch field targets only `artifacts/pr-{n}` (never `/pulls/` or `refs/pull/...`), image-vs-link Markdown selection, existing-file sha reuse, GitHub API success/failure paths.
- `/tests/providers/github/add-issue-comment-tool.spec.ts`: comment posting -- validation, authorship-footer application, activity logging, GitHub API success/failure paths.
- `/tests/providers/github/list-issue-comments-tool.spec.ts`: comment listing -- validation, pagination bounds, `Link` header `hasMore`, GitHub API success/failure paths.
- `/tests/providers/github/get-issue-tool.spec.ts`: issue fetch -- validation, field normalization, GitHub API success/failure paths.
- `/tests/providers/github/update-issue-tool.spec.ts`: issue update -- validation (including "at least one field" and milestone-clearing), authorship-footer application, partial-PATCH body construction, activity logging, GitHub API success/failure paths.
- `/tests/providers/github/get-pull-request-tool.spec.ts`: PR fetch -- validation, field normalization, GitHub API success/failure paths.
- `/tests/providers/github/list-pull-request-files-tool.spec.ts`: PR file listing -- validation, pagination bounds, `Link` header `hasMore`, GitHub API success/failure paths.
- `/tests/providers/github/update-pull-request-tool.spec.ts`: PR update -- validation, REST PATCH body construction, REST-then-GraphQL draft-toggle sequencing and post-toggle refetch, activity logging, GitHub API success/failure paths.
- `/tests/providers/github/list-pull-request-review-threads-tool.spec.ts`: review thread listing -- validation and `first` clamping, missing/inaccessible-PR error path, field normalization, GraphQL success/failure paths.
- `/tests/providers/github/reply-to-review-thread-tool.spec.ts`: review thread reply -- validation, authorship-footer application, activity logging, GraphQL success/failure paths.
- `/tests/providers/github/resolve-review-thread-tool.spec.ts`: review thread resolution -- validation, activity logging, GraphQL success/failure paths.
- `/tests/providers/github/unresolve-review-thread-tool.spec.ts`: review thread reopening -- validation, activity logging, GraphQL success/failure paths.
- `/tests/providers/github/list-organization-projects-tool.spec.ts`: org Projects v2 listing -- validation and `first` clamping, missing/inaccessible-organization error path, GraphQL success/failure paths.
- `/tests/providers/github/add-pull-request-to-project-tool.spec.ts`: PR-to-project addition -- validation, PR-lookup-then-add sequencing, missing-PR/missing-item error paths, activity logging, GraphQL success/failure paths.
- `/tests/providers/github/assign-to-current-user-tool.spec.ts`: self-assignment -- validation, proof the assignee is always and only the configured identity, activity logging, GitHub API success/failure paths.
- `/tests/providers/github/search-repository-items-tool.spec.ts`: issue/PR search -- validation, repo/type-scoped query construction, `hasMore` derivation, activity logging, GitHub API success/failure paths.
- `/tests/providers/github/link-github-item-tool.spec.ts`: Paperclip-side GitHub link -- `github.com`-hostname validation, additive-link/update-on-relink behavior, persistence-failure handling, activity logging.

## Change guidance

When adding or changing a GitHub tool:

- Add or update a shared metadata file under `/src/shared/` and add its manifest fragment to `/src/providers/github/manifest-tools.ts`.
- Add the runtime `ProviderToolSpec` under `/src/providers/github/tools/` and register it in the provider's `tools` array in `/src/providers/github/index.ts`. (`/src/worker.ts` and `/src/manifest.ts` are name-agnostic -- they iterate the registry, so neither needs a per-tool edit.)
- Update the tool-count assertions in `/tests/providers/github/provider.spec.ts` and `/tests/providers/github/manifest-tools.spec.ts`, which pin the exact registered tool set.
- Reuse `/src/identity-policy.ts` and `/src/credential-sidecar.ts` rather than resolving tokens directly.
- Keep input validation and repository normalization before credential resolution.
- Include tests that prove secrets are not resolved for malformed inputs and other pre-credential denial paths.
- Redact token forms from any command output returned to agents.
- Log useful activity metadata, but never log or return tokens/private keys.
