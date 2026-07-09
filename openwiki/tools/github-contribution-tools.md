# GitHub contribution tools

The plugin exposes three GitHub-related agent tools. Tool metadata lives in shared definition files so `/src/manifest.ts` and `/src/worker.ts` use consistent names and schemas.

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
- implementation: `/src/tools/create-pull-request.ts`

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

- metadata: `/src/github-bot-push-branch-tool-definition.ts`
- implementation: `/src/github-bot-push-branch.ts`

Purpose: mediate pushing current workspace `HEAD` to a branch on a GitHub remote using the agent identity token.

Parameters:

- `branch` (required): destination branch/ref. The implementation pushes `HEAD:refs/heads/<branch>` unless the input already starts with `refs/heads/`.
- `remote` (optional): git remote name, default `origin`.
- `expectedRepository` (optional): `owner/repo` or GitHub URL that must match the resolved remote before pushing.
- `dryRun` (optional): when true, adds `--dry-run` to `git push`.

Runtime behavior:

1. validates params and rejects empty, whitespace-containing, NUL-containing, or dash-prefixed branch/remote values;
2. gets the primary workspace via `ctx.projects.getPrimaryWorkspace(runCtx.projectId, runCtx.companyId)`;
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

## Shared redaction and helper utilities

`/src/lib/redaction.ts` provides recursive redaction for strings, arrays, and objects, plus safe error conversion.

`/src/lib/push.ts` contains a lower-level push helper with similar askpass/redaction cleanup behavior. It removes inherited `GITHUB_TOKEN` and `PAPERCLIP_GIT_PUSH_TOKEN` from the child environment. This helper is tested by `/tests/security.spec.ts`; the currently registered mediated push tool has its own implementation in `/src/github-bot-push-branch.ts`.

`/src/lib/pr.ts` wraps PR client errors with redaction. It is covered by security tests even though the registered PR tool currently calls `ctx.http.fetch` directly.

## Test map

- `/tests/create-pull-request.spec.ts`: PR validation, malformed repo before secrets, success path, draft flag, activity logging, canonical API URL, credential/API/fetch error behavior, no token leakage.
- `/tests/plugin.spec.ts`: `whoami`, push success and denial paths, dry-run behavior, sidecar integration, redaction on push failure.
- `/tests/security.spec.ts`: generic redaction, PR helper redaction, push helper token handling and cleanup.
- `/tests/identity-policy.spec.ts`: identity and credential resolution used by all tools.

## Change guidance

When adding or changing a GitHub tool:

- Add or update a shared metadata file and include it in `/src/manifest.ts`.
- Register the runtime implementation in `/src/worker.ts`.
- Reuse `/src/identity-policy.ts` and `/src/credential-sidecar.ts` rather than resolving tokens directly.
- Keep input validation and repository normalization before credential resolution.
- Include tests that prove secrets are not resolved for malformed inputs and other pre-credential denial paths.
- Redact token forms from any command output returned to agents.
- Log useful activity metadata, but never log or return tokens/private keys.
