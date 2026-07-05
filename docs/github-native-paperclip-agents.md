# GitHub-native Paperclip agents

Issue: https://github.com/roshangautam/paperclip-github-bot-identity-plugin/issues/8

## Goal

Make Paperclip agents usable from GitHub in the same workflow shape as Copilot, Claude, and Codex agents: a human should be able to route work from a GitHub issue or pull request to a named Paperclip agent, and Paperclip should wake the right internal agent with enough context to act safely.

The important distinction is that there are two different goals:

1. **GitHub-native visibility**: an actor appears in GitHub UI affordances such as assignees, reviewers, mentions, and audit logs.
2. **Paperclip-native routing**: GitHub events are mapped to Paperclip companies, agents, issues, projects, runs, and policy.

The MVP should prioritize Paperclip-native routing first, because it is safer and does not require creating broad GitHub user accounts for every Paperclip agent. Full GitHub-native assignee/reviewer presence can come later for selected agents.

## Findings

### GitHub issue assignees are users/collaborators, not arbitrary app identities

GitHub's REST docs define issue/pull-request assignees as managed through the issue assignees API. In this repo, the live assignable-users endpoint currently returns only `roshangautam`:

```sh
gh api repos/roshangautam/paperclip-github-bot-identity-plugin/assignees --paginate
# roshangautam User
```

Checking non-collaborator user accounts such as `claude` or `codex` through `GET /repos/{owner}/{repo}/assignees/{assignee}` returns `404 Not Found`, which is GitHub's documented response shape for a user who cannot be assigned.

Evidence:

- GitHub REST docs, issue assignees: https://docs.github.com/en/rest/issues/assignees
- Live API evidence from this repo: only `roshangautam` is currently assignable.
- Live API evidence from this repo: `GET /repos/roshangautam/paperclip-github-bot-identity-plugin/assignees/{assignee}` returns 204 for `roshangautam`, and 404 for `claude`, `codex`, and `renovate` unless they are added as collaborators or otherwise granted repository access.

Conclusion: a GitHub App installation identity alone is not enough to appear in the issue assignee picker as a normal assignable user. To be truly selectable as an assignee, a Paperclip agent likely needs either:

- a real GitHub user or machine account added as a collaborator/org member, or
- a GitHub-native special integration that GitHub itself exposes, as Copilot does.

We cannot assume a custom third-party GitHub App can add arbitrary pseudo-users to the assignee dropdown.

### Pull request reviewers require write access

GitHub's review-request docs state: "Pull request authors and repository owners and collaborators can request a pull request review from anyone with write access to the repository." Each requested reviewer receives a notification.

Evidence:

- GitHub REST docs, review requests: https://docs.github.com/en/rest/pulls/review-requests

Conclusion: for a Paperclip agent to be directly requested as a reviewer in GitHub's reviewer picker, it needs to be represented by a GitHub user/account with write access, or by a team if using team review requests. A GitHub App can receive `pull_request` webhooks and act on PRs, but that is not the same UX as a reviewer account in the reviewer dropdown.

### GitHub Apps are the right integration substrate, but not full user stand-ins

GitHub's App docs say GitHub Apps can:

- be installed on organizations, users, or repositories,
- have narrow permissions,
- receive built-in webhooks,
- act independently of a user via installation access tokens,
- act on behalf of a user via user access tokens.

GitHub also says Apps are intended to reduce friction "without needing to sign in a user or create a service account," and can act independently of users. That is exactly right for webhook routing and mediated automation. However, acting independently as an app is not equivalent to becoming a selectable human-style assignee/reviewer.

Evidence:

- GitHub App docs, about creating GitHub Apps: https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps
- GitHub App docs, choosing permissions: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- GitHub App docs, authentication: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app

Conclusion: use a GitHub App for install, permissions, webhooks, comments, labels, statuses, and token vending. Use machine users only where GitHub UI selectability is required.

### Webhooks can wake Paperclip reliably

GitHub webhooks include issue assignment events, issue comments, pull request events, review-request events, labels, and other repository events. GitHub webhook payloads include the `installation` object when delivered to a GitHub App, and include repository/organization/sender context.

Evidence:

- GitHub webhook docs: https://docs.github.com/en/webhooks/webhook-events-and-payloads
- GitHub App permissions docs point webhook availability and required permissions back to webhook documentation.

Useful webhook events for the MVP are `issue_comment.created`, `issues.labeled`, `pull_request.labeled`, and later `issues.assigned` / `pull_request.review_requested` if a machine-user pilot is enabled.

Conclusion: Paperclip can wake agents from GitHub events without making every Paperclip agent a GitHub account. The GitHub App should receive events, verify signatures, map the event to a Paperclip company/project/agent, and create/wake a Paperclip issue or run.

## Recommended architecture

Use a two-layer model.

```text
GitHub UI event
  -> Paperclip GitHub App webhook
  -> GitHub routing adapter
  -> Paperclip agent identity registry
  -> Paperclip issue/run wakeup
  -> GitHub bot identity plugin for writes
  -> GitHub comment/status/PR updates
```

### Layer 1: GitHub App gateway

A single GitHub App, for example `Paperclip Agents`, should own the GitHub integration boundary.

Responsibilities:

- Install per repo/org.
- Receive and verify GitHub webhooks.
- Hold repository-scoped installation permissions.
- Translate GitHub events into Paperclip routing events.
- Add comments/status labels back to GitHub for visibility.
- Never expose provider tokens to agent shells.

Recommended initial permissions:

- Issues: read/write, for comments, labels, assignment event handling.
- Pull requests: read/write, for PR comments/review-request event handling.
- Contents: read/write only if the app will push branches directly. Otherwise defer branch pushes to the GitHub Bot Identity plugin.
- Metadata: read, mandatory.
- Webhooks subscribed: `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`, `label`, optionally `check_run`/`check_suite` later.

### Layer 2: Paperclip agent identity registry

Store a mapping like:

```ts
type GitHubAgentRoute = {
  companyId: string;
  paperclipAgentId: string;
  githubHandle?: string;       // machine user, optional
  commandAliases: string[];    // e.g. ["kiln-lathe", "cto"]
  labels: string[];            // e.g. ["paperclip:agent/kiln-lathe"]
  allowedRepos: string[];      // e.g. ["roshangautam/*"]
  allowedEvents: string[];     // issue_comment, issues.assigned, pull_request.review_requested
  defaultProjectId?: string;
  defaultPriority?: "low" | "normal" | "high";
};
```

This registry can live first in plugin config. Later it can become a shared identity broker table.

## UX options

### Option A, safest MVP: labels and slash commands

A human routes work with labels or comments:

- Add label: `paperclip:agent/kiln-lathe`
- Comment: `/paperclip assign kiln-lathe`
- Comment: `/paperclip review zara-thorn`

The GitHub App receives the event, maps `kiln-lathe` to a Paperclip agent, creates or links a Paperclip issue, and wakes that agent.

Pros:

- No machine-user sprawl.
- No need for each agent to be a GitHub collaborator.
- Works with one GitHub App installation.
- Easy to audit and revoke.
- Safe default for Droidshop/Paperclip dogfooding.

Cons:

- Agents do not appear in GitHub's native assignee/reviewer picker.
- Users need to learn a label/comment command convention.

Recommendation: this should be the first implementation.

### Option B, hybrid: one visible GitHub App plus Paperclip-side agent routing

Use a single GitHub App actor for GitHub comments/statuses. The App comments with clear attribution:

```text
Paperclip routed this issue to Kiln Lathe (Droidshop CTO).
Run: DRO-123 / heartbeat abc123
Status: queued
```

For reviewer-like flows, humans request the GitHub App by command/comment rather than through native reviewer picker.

Pros:

- Lowest GitHub account management overhead.
- Clear app-level audit trail.
- Still preserves per-agent identity inside Paperclip.

Cons:

- Native GitHub UI shows the app, not each internal agent.

Recommendation: pair this with Option A.

### Option C, true native assignee/reviewer: machine users per agent

Create GitHub machine users for selected Paperclip agents and add them as collaborators or org members with appropriate repository access. Examples:

- `paperclip-kiln-lathe`
- `paperclip-zara-thorn`
- `paperclip-rhea-corvus`

Those users can be native assignees/reviewers if they have the required repository access. Paperclip can map webhook payloads mentioning those GitHub logins back to internal agents.

Pros:

- Best native GitHub UX.
- Agents can appear in assignee/reviewer pickers.
- GitHub notifications and audit logs point at distinct bot accounts.

Cons:

- Operational overhead: accounts, 2FA, recovery, org membership, billing/seats, PAT/app authorization, lifecycle.
- Higher blast radius if each account gets write access.
- Review request requires write access, which may be too much for QA-only or read-only agents.
- Harder offboarding and rotation story.

Recommendation: use only for a few high-value external-facing agents after the GitHub App gateway and bot identity plugin are working.

### Option D, team-based routing

Create GitHub teams such as:

- `@roshangautam/paperclip-agents`
- `@roshangautam/paperclip-reviewers`
- `@roshangautam/droidshop-cto-agent`

Humans request team reviews or mention teams. The GitHub App routes team review/comment events to Paperclip agents based on team slug.

Pros:

- Better native reviewer flow than labels in org-owned repos.
- Fewer accounts than one machine user per agent.

Cons:

- Works best in org-owned repos, less useful for user-owned repos.
- Still does not make individual Paperclip agents appear as individual GitHub users.

Recommendation: consider later if repos move into an org.

## MVP path

### Milestone M3.1: routing-only GitHub App

Build a GitHub App gateway that supports:

- `/paperclip assign <agent-alias>` in issue comments.
- `paperclip:agent/<agent-alias>` labels.
- `paperclip:review/<agent-alias>` labels on PRs.
- Webhook signature verification.
- Repo allow-list enforcement.
- Agent alias -> Paperclip agent ID mapping.
- Creates/links a Paperclip issue and wakes the agent.
- Comments back with route status.

This requires no machine users and no raw agent GitHub tokens.

### Milestone M3.2: review-request style flows

Add PR-specific routing:

- `/paperclip review <agent-alias>` comments on PRs.
- Optional `paperclip:review/<agent-alias>` label.
- Create Paperclip review issue assigned to that agent.
- Agent posts review outcome back through mediated GitHub tool comments.

### Milestone M3.3: selected machine-user pilot

Pick one agent, likely a QA/reviewer agent, and create a machine user only for that agent.

Pilot requirements:

- Machine user has least privilege repo access.
- GitHub login maps to exactly one Paperclip agent.
- Webhooks for assignment/review request wake that Paperclip agent.
- The bot identity plugin handles all writes, or the machine user's token is used only through the plugin, never in the agent shell.
- Deprovisioning checklist exists.

## Security rules

1. **Do not make every Paperclip agent a GitHub user up front.** Start with app-mediated labels/commands.
2. **Do not inject machine-user PATs into agent env.** Use the bot identity plugin for all writes.
3. **Fail closed on repo/owner mismatch.** A label or command in `paperclipai/paperclip` should not wake a Droidshop agent unless explicitly configured.
4. **Verify webhook signatures.** Reject unsigned or invalid payloads.
5. **Record audit mapping.** Every GitHub event should record GitHub actor, event ID, repo, issue/PR, Paperclip company, agent, run, and decision.
6. **Separate GitHub visibility from provider credential.** A machine user being assignable does not imply its token should be available to the agent.
7. **Use explicit commands for destructive actions.** `/paperclip assign` is routing. `/paperclip approve` or merge actions should remain separate and permissioned.

## Open questions

- Should the first GitHub App live under the user account or a new organization that owns Paperclip-related repos?
- Should Droidshop repos eventually move from `roshangautam/*` into an org to unlock team-based review routing?
- Which one agent should pilot machine-user assignability if we test Option C?
- Should Paperclip issue keys be mirrored into GitHub labels/comments, or should GitHub issue links remain only in plugin metadata?
- Do we want Paperclip to support GitHub App commands as a separate plugin, or fold routing into this bot-identity plugin?

## Recommendation

Do **not** try to make every Paperclip agent a native GitHub assignee/reviewer in the first pass. It creates account sprawl and write-access pressure before the mediated identity path is proven.

Build the GitHub App gateway first with labels and slash commands. This gets the working dogfood loop:

```text
GitHub issue comment or label
  -> Paperclip route
  -> Paperclip agent wakes
  -> bot identity plugin pushes/opens PR/comments
  -> GitHub shows auditable app/bot output
```

Then pilot one machine-user-backed agent only if native assignee/reviewer UX proves valuable enough to justify the account lifecycle cost.
