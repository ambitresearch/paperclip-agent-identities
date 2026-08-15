# Paperclip bot approval for GitHub PRs

Use this after automated review is clean but GitHub still reports `REVIEW_REQUIRED`, when repository governance permits an independent Paperclip agent to approve.

## Prefer the provider tool

Do not read or copy bot tokens. Execute the Agent Identities plugin's sanctioned review tool so it mints and uses the selected agent's GitHub App credential internally.

```bash
paperclipai plugin tool:execute --payload-json '{
  "tool":"ambitresearch.paperclip-agent-identities:github_bot_submit_pull_request_review",
  "parameters":{
    "repository":"OWNER/REPO",
    "pullNumber":123,
    "event":"APPROVE",
    "body":"Reviewed the current head; checks pass and review threads are resolved."
  },
  "runContext":{
    "agentId":"NON_AUTHOR_AGENT_UUID",
    "companyId":"COMPANY_UUID",
    "projectId":"PROJECT_UUID",
    "runId":"EXISTING_RUN_UUID_BELONGING_TO_THE_COMPANY"
  }
}' --json
```

## Request-shape constraints

- The tool argument field is `parameters`, not `params` or `arguments`.
- `runContext` requires non-empty UUIDs for `agentId`, `runId`, `companyId`, and `projectId`.
- Do not invent `runId`; Paperclip checks that it belongs to the company. Reuse a real run UUID from relevant Paperclip issue/run history.
- Select a configured GitHub-enabled agent that did not author the PR and is permitted by repository governance.
- A paused agent can still be usable as the identity selected by the tool; credential resolution, not heartbeat status, determines whether review submission succeeds.

## Discover inputs without exposing secrets

- `paperclipai company list --json`
- `paperclipai project list -C COMPANY_UUID --json`
- `paperclipai agent list -C COMPANY_UUID --json`
- relevant issue/run history for a real run UUID
- `paperclipai plugin tools --json` to confirm the fully qualified tool name and schema
- `paperclipai openapi --json` when the CLI payload shape is unclear

Do not print adapter secret values, credential sidecars, private keys, or tokens.

## Verify the side effect

The command succeeding is not enough. Confirm:

1. returned review `state` is `APPROVED` and a review URL/ID exists;
2. GitHub review author is the intended bot;
3. review `commit.oid` equals the current PR head;
4. unresolved thread count is zero;
5. `reviewDecision` and `mergeStateStatus` changed as expected.

Never merge unless the user separately authorized merging.
