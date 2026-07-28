# GitHub contribution tools

The plugin exposes four GitHub-related agent tools. Tool metadata lives in shared definition files so `/src/manifest.ts` and `/src/worker.ts` use consistent names and schemas.

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

Runtime behavior:

1. validates params and rejects empty, whitespace-containing, NUL-containing, or dash-prefixed branch/remote values;
2. lists the invoking agent's in-progress project issues, matches `runCtx.runId` against `executionRunId` or `checkoutRunId`, and uses that issue's execution workspace `cwd` (or `path`); when no usable execution workspace is available, falls back to the project's primary workspace;
3. runs `git remote get-url <remote>` in the workspace;
4. normalizes the remote URL to a GitHub owner/repo;
5. resolves the agent identity;
6. if `expectedRepository` is provided, normalizes it and requires exact match with the resolved remote;
7. resolves credentials just in time;
8. creates a temporary `GIT_ASKPASS` script and sets `GIT_TERMINAL_PROMPT=0` plus `GITHUB_TOKEN` in the child environment;
9. runs `git -c credential.helper= push [--dry-run] https://github.com/{owner}/{repo}.git HEAD:refs/heads/{branch}`;
10. redacts raw token, URL-encoded token, and basic-auth token forms from stdout/stderr and thrown errors;
11. cleans the temporary askpass directory in `finally`.

Activity logging captures outcomes such as invalid branch, missing workspace, remote resolution failure, unsupported remote, expected-repository mismatch, credential failure, push failure, exception, and success.

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

**Manifest permissions**: `github_bot_get_pull_request_checks` reads Checks-API and commit-status data that
requires the App to hold `checks: read` and `statuses: read` repository permissions in addition to the
existing `pull_requests`/`contents`/`issues`/`workflows` grants. `/src/providers/github/app-manifest.ts`'s
`createGitHubAppManifestFlow` now requests both by default for *newly created* App manifests. As documented
in that file, this has no effect on an already-installed App -- existing installations must add `checks:read`
and `statuses:read` themselves (GitHub App settings -> Permissions & events) before
`github_bot_get_pull_request_checks` will succeed against them. `github_bot_request_pull_request_reviewers`
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
   `raw.githubusercontent.com/{owner}/{repo}/{commitSha}/{filePath}` URL (not a branch-relative URL), so a
   later upload to the same file name never changes what a previously-shared Markdown reference renders. If
   the response omits a commit sha, the tool returns an error rather than a URL that isn't durable;
9. logs a `pull_request` activity entry with the artifact branch, commit sha, file name, and raw URL (never
   the token);
10. returns the commit-pinned raw URL, branch, commit sha, file path, and Markdown snippet.

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

## Shared redaction and helper utilities

`/src/lib/redaction.ts` provides recursive redaction for strings, arrays, and objects, plus safe error conversion.

`/src/lib/push.ts` contains a lower-level push helper with similar askpass/redaction cleanup behavior. It removes inherited `GITHUB_TOKEN` and `PAPERCLIP_GIT_PUSH_TOKEN` from the child environment. This helper is tested by `/tests/security.spec.ts`; the currently registered mediated push tool has its own implementation in `/src/providers/github/tools/push-branch.ts`.

`/src/lib/pr.ts` wraps PR client errors with redaction. It is covered by security tests even though the registered PR tool currently calls `ctx.http.fetch` directly.

## Test map

- `/tests/create-pull-request.spec.ts`: PR validation, malformed repo before secrets, success path, draft flag, activity logging, canonical API URL, credential/API/fetch error behavior, no token leakage.
- `/tests/providers/github/submit-pull-request-review-tool.spec.ts`: review event/param validation, malformed inline comments, repository normalization before credentials, fail-closed on missing token, APPROVE/REQUEST_CHANGES/COMMENT success paths, activity logging with agent attribution and no token leakage, network/API failure handling.
- `/tests/plugin.spec.ts`: `whoami`, push success and denial paths, dry-run behavior, sidecar integration, redaction on push failure.
- `/tests/security.spec.ts`: generic redaction, PR helper redaction, push helper token handling and cleanup.
- `/tests/identity-policy.spec.ts`: identity and credential resolution used by all tools.
- `/tests/providers/github/get-issue-interaction-summary-tool.spec.ts`: Paperclip-side-only interaction summary -- window validation, missing-issue/listComments-failure handling, `[from, to)` filtering, soft-delete exclusion, deterministic ordering, secret redaction/truncation, activity logging.
- `/tests/providers/github/upload-pull-request-asset-tool.spec.ts`: PR asset upload -- validation, fail-closed on missing token, proof that every request/branch field targets only `artifacts/pr-{n}` (never `/pulls/` or `refs/pull/...`), image-vs-link Markdown selection, existing-file sha reuse, GitHub API success/failure paths.

## Change guidance

When adding or changing a GitHub tool:

- Add or update a shared metadata file and include it in `/src/manifest.ts`.
- Register the runtime implementation in `/src/worker.ts`.
- Reuse `/src/identity-policy.ts` and `/src/credential-sidecar.ts` rather than resolving tokens directly.
- Keep input validation and repository normalization before credential resolution.
- Include tests that prove secrets are not resolved for malformed inputs and other pre-credential denial paths.
- Redact token forms from any command output returned to agents.
- Log useful activity metadata, but never log or return tokens/private keys.
