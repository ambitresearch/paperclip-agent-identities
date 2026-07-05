# GitHub-native Paperclip agents

Issue: https://github.com/roshangautam/paperclip-github-bot-identity-plugin/issues/8

## Goal

Make Paperclip agents usable from GitHub in the same workflow shape as Copilot, Claude, and Codex agents: a human should be able to route work from a GitHub issue or pull request to a named Paperclip agent, and Paperclip should wake the right internal agent with enough context to act safely.

The important distinction is that there are two different goals:

1. **GitHub-native visibility**: an actor appears in GitHub UI affordances such as assignees, reviewers, mentions, and audit logs.
2. **Paperclip-native routing**: GitHub events are mapped to Paperclip companies, agents, issues, projects, runs, and policy.

---

## Deep research: how Claude, Codex, and Copilot coding agents appear in GitHub

### Summary of findings

Claude, Codex, and GitHub Copilot coding agents appear in GitHub as **Bot-type actors backed by GitHub Apps** that have been registered through GitHub's **"agent apps" program** (public preview, June 2026). They are **not** normal GitHub user accounts, machine users, or simple OAuth apps. They use a special assignment code path that differs from the standard REST assignees API.

### Evidence from this repository

Issues #1 and #2 in this repo carry live coding-agent assignments:

| Issue | Assignee display name | REST `type` | `html_url` | GraphQL `assignedActors` login |
|-------|----------------------|-------------|------------|-------------------------------|
| #1 | Codex | Bot | `https://github.com/apps/openai-code-agent` | `openai-code-agent` |
| #2 | Claude | Bot | `https://github.com/apps/anthropic-code-agent` | `anthropic-code-agent` |

Key observations:

1. **Only `roshangautam` appears in `GET /repos/{owner}/{repo}/assignees`** (the standard assignable-users endpoint). The Bot actors do not appear there.
2. **`GET /repos/{owner}/{repo}/assignees/{assignee}` returns 404** for `Codex`, `Claude`, `openai-code-agent`, and `anthropic-code-agent`. The standard REST assignability check does not recognize them.
3. **`gh issue edit --add-assignee Codex` (or Claude) does not persist** when attempted via CLI on other issues (#3-#8), confirming the standard assignment path cannot add these actors.
4. **Yet issues #1 and #2 hold these Bot actors as assignees.** This proves a different code path was used to create these assignments.

### The mechanism: GitHub's coding agent assignment system

Based on research of GitHub's APIs, documentation, and changelogs:

#### 1. These are GitHub App bot users, not regular users

Each coding agent is backed by a registered GitHub App:
- `anthropic-code-agent` is the bot user for the Anthropic Claude GitHub App
- `openai-code-agent` is the bot user for the OpenAI Codex GitHub App
- `copilot-swe-agent` is the bot user for GitHub's own Copilot coding agent

These appear with `type: "Bot"` in REST responses and resolve to `https://github.com/apps/<slug>`.

#### 2. Assignment uses a special GraphQL path, not the REST assignees endpoint

GitHub's December 2025 changelog ("Assign issues to Copilot using the API") introduced:

- GraphQL mutations: `addAssigneesToAssignable`, `replaceActorsForAssignable`, `updateIssue`, `createIssue`
- **Required header**: `GraphQL-Features: issues_copilot_assignment_api_support`
- A `suggestedActors(capabilities: [CAN_BE_ASSIGNED])` query on repositories to discover assignable agents

The `replaceActorsForAssignable` mutation uses an **actor abstraction** rather than the classic user-only assignee model. It can assign Bot-type actors that would fail validation through the REST `/assignees` endpoint. This is a different internal code path with looser validation for recognized agent apps.

#### 3. The "agent apps" program gates who can appear

GitHub's "Extend GitHub with agent apps" (June 2, 2026 changelog) established:

- **Agent apps** are GitHub Apps registered through a partner program (currently waitlist-based)
- Once registered and installed, they appear in the **assignee dropdown/picker** in GitHub's UI
- Users can assign issues to them, mention them in PR comments, or select them in the Agents tab
- First partners: Anthropic (Claude), OpenAI (Codex), plus Amplitude, Bright Security, Endor Labs, LaunchDarkly, Miro, Sonar, PagerDuty, Packfiles, Octopus Deploy
- GitHub stated they will "open up access for anyone to build agent apps" over the coming months

#### 4. Requirements for an agent app to be assignable

| Requirement | Details |
|------------|---------|
| GitHub App registration | Must be a registered GitHub App with agent app capabilities |
| Agent apps program membership | Currently requires partner waitlist approval |
| Copilot subscription | Repository owner needs Copilot Pro, Pro+, Business, or Enterprise |
| Repository/org enablement | Admin must enable "Partner Agents" or specific agents in Settings > Copilot > Coding Agent |
| Enterprise policy (if applicable) | Enterprise admin must enable "Agent apps" in Copilot enterprise settings |
| OAuth authorization | User must authorize the agent app via OAuth on first use |
| App installation | App must be installed on the repository or organization |

#### 5. The `suggestedActors` GraphQL query reveals assignable agents

```graphql
query {
  repository(owner: "OWNER", name: "REPO") {
    suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
      nodes {
        login
        __typename
        ... on Bot { id }
        ... on User { id }
      }
    }
  }
}
```

This query (with the feature header) returns both human collaborators and registered agent app bots that can be assigned in that repository.

#### 6. Self-assignment mechanism for GitHub App bots

A GitHub App bot can assign itself to an issue using:
```
POST /repos/{owner}/{repo}/issues/{issue_number}/assignees
{ "assignees": ["<app-slug>[bot]"] }
```

This works when:
- The app is installed on the repository
- The app has `issues:write` permission
- The app authenticates via its installation access token

However, **this alone does not make the bot appear in the assignee picker for humans**. The agent apps program registration is what enables UI-level discoverability.

### Why the standard REST assignees endpoint returns 404

The REST `GET /repos/{owner}/{repo}/assignees/{assignee}` endpoint uses the **legacy validation model** that only recognizes:
- Repository collaborators (users with explicit access)
- Organization members (for org-owned repos)

It does **not** recognize agent app bot users, even though those bots can hold assignments created through the GraphQL coding-agent path. This is a deliberate design split: the older REST endpoint predates the agent model.

---

## Can per-agent Paperclip GitHub Apps appear in the assignee/reviewer picker?

### Answer: Not yet through self-service, but the path is opening

| Approach | Can appear in picker? | Status |
|----------|----------------------|--------|
| Standard GitHub App (not in agent apps program) | **No** - will not appear in assignee dropdown | Available now |
| GitHub App registered as agent app (partner program) | **Yes** - appears in assignee dropdown and Agents tab | Waitlist/partner program only (June 2026) |
| Machine user added as collaborator | **Yes** - appears in standard assignee dropdown | Available now, operational overhead |
| GitHub App bot self-assigning via API | **Partially** - can hold assignment, but not discoverable in picker | Available now |

### What Paperclip would need to do

**Option 1 (Recommended near-term): Single GitHub App + Paperclip-side routing**
- Does not require agent apps program membership
- Uses labels, slash commands, and app comments for routing
- Paperclip agents do NOT appear in GitHub's native assignee picker
- Fastest to implement, safest, no account sprawl

**Option 2 (Medium-term): Register as a GitHub agent app**
- Join the agent apps waitlist/partner program
- Once approved, Paperclip's GitHub App would appear in the assignee picker
- Users could assign issues directly to "Paperclip" from the dropdown
- Internal routing would map the single app assignment to specific Paperclip agents
- Requires Copilot subscription on the repository owner side

**Option 3 (Future): Per-agent agent apps**
- Register multiple GitHub Apps (one per Paperclip agent) in the agent apps program
- Each would appear individually in the picker (e.g., "Kiln Lathe", "Zara Thorn")
- Maximum native UX fidelity
- Highest operational overhead and program membership complexity
- May not be feasible until GitHub opens agent apps to all developers

**Option 4 (Available now but costly): Machine users per agent**
- Create GitHub user accounts for selected agents
- Add them as repository collaborators
- They appear in the standard assignee/reviewer picker immediately
- High account lifecycle cost (2FA, billing, PATs, offboarding)
- Each account needs explicit repository access grants

---

## Detailed architecture: how coding agents integrate

```text
GitHub UI / API
  │
  ├─ User assigns issue to agent via picker or GraphQL mutation
  │   (requires: agent apps program + Copilot subscription + repo enablement)
  │
  ├─ GraphQL: replaceActorsForAssignable / addAssigneesToAssignable
  │   (header: GraphQL-Features: issues_copilot_assignment_api_support)
  │
  └─ GitHub dispatches webhook to agent app
      │
      ├─ issues.assigned event (payload includes Bot actor)
      ├─ issue_comment.created event (if @mentioned)
      └─ pull_request events
          │
          └─ Agent app backend (Anthropic/OpenAI/Copilot infra)
              │
              ├─ Receives task, creates sandbox environment
              ├─ Reads issue context, plans work
              ├─ Creates branch, makes changes, opens PR
              └─ Reports back via comments/status checks
```

For Paperclip, the equivalent flow would be:

```text
GitHub UI event (assignment, label, slash command, or @mention)
  │
  └─ Paperclip GitHub App webhook
      │
      ├─ Verify webhook signature
      ├─ Check repo allow-list
      ├─ Map GitHub event to Paperclip agent identity
      │   (via agent registry: label/command/assignee → agent ID)
      │
      └─ Paperclip agent identity registry
          │
          ├─ Create/link Paperclip issue
          ├─ Wake target agent with context
          ├─ Agent executes via bot identity plugin (mediated writes)
          └─ Comments/PR updates posted back through GitHub App
```

---

## Recommended architecture

### Layer 1: GitHub App gateway (implement now)

A single GitHub App, for example `Paperclip Agents`, owns the GitHub integration boundary.

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
  githubHandle?: string;       // machine user or agent app slug, optional
  commandAliases: string[];    // e.g. ["kiln-lathe", "cto"]
  labels: string[];            // e.g. ["paperclip:agent/kiln-lathe"]
  allowedRepos: string[];      // e.g. ["roshangautam/*"]
  allowedEvents: string[];     // issue_comment, issues.assigned, pull_request.review_requested
  defaultProjectId?: string;
  defaultPriority?: "low" | "normal" | "high";
};
```

This registry can live first in plugin config. Later it can become a shared identity broker table.

### Layer 3: Agent apps program registration (when available)

Once GitHub opens the agent apps program beyond partner waitlist:

1. Register the Paperclip GitHub App as an agent app
2. Configure OAuth authorization flow
3. Implement the coding-agent task reception protocol
4. Handle `issues.assigned` webhooks where the assignee is the Paperclip bot
5. Map internal Paperclip agents via configuration (single app → multiple internal agents)

---

## UX options

### Option A, safest MVP: labels and slash commands (implement first)

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
- No dependency on agent apps program or Copilot subscription.
- Safe default for Droidshop/Paperclip dogfooding.

Cons:

- Agents do not appear in GitHub's native assignee/reviewer picker.
- Users need to learn a label/comment command convention.

### Option B, hybrid: one visible GitHub App plus Paperclip-side agent routing

Use a single GitHub App actor for GitHub comments/statuses. The App comments with clear attribution:

```text
Paperclip routed this issue to Kiln Lathe (Droidshop CTO).
Run: DRO-123 / heartbeat abc123
Status: queued
```

For reviewer-like flows, humans request the GitHub App by command/comment rather than through native reviewer picker.

### Option C, agent app registration: native assignee picker (when program opens)

Register Paperclip's GitHub App as an agent app. Once approved:

- "Paperclip" appears in the issue assignee dropdown
- Users assign issues to Paperclip directly from the picker
- Paperclip's webhook receives `issues.assigned` with its Bot actor
- Internal routing maps the assignment to the correct Paperclip agent based on issue labels, project, or explicit configuration

This is how Claude and Codex work today. The key insight is that they appear as a **single bot identity per provider** (not one per internal agent), with internal routing handled server-side.

### Option D, true per-agent native assignees: machine users or multiple agent apps

Create separate identities for each Paperclip agent visible in GitHub. Two sub-paths:

**D1: Machine users (available now)**
- Create GitHub accounts like `paperclip-kiln-lathe`, `paperclip-zara-thorn`
- Add as repo collaborators
- Appear in standard assignee picker immediately
- High lifecycle cost

**D2: Multiple agent apps (future, when program opens widely)**
- Register separate GitHub Apps per agent
- Each appears in the agent picker
- Maximum fidelity but highest operational complexity

### Option E, team-based routing

Create GitHub teams such as `@org/paperclip-agents`. Humans mention teams or request team reviews. The GitHub App routes team events to Paperclip agents based on team slug.

---

## MVP path

### Milestone M3.1: routing-only GitHub App (implement now)

Build a GitHub App gateway that supports:

- `/paperclip assign <agent-alias>` in issue comments.
- `paperclip:agent/<agent-alias>` labels.
- `paperclip:review/<agent-alias>` labels on PRs.
- Webhook signature verification.
- Repo allow-list enforcement.
- Agent alias -> Paperclip agent ID mapping.
- Creates/links a Paperclip issue and wakes the agent.
- Comments back with route status.

This requires no machine users, no agent apps program membership, and no Copilot subscription.

### Milestone M3.2: GitHub App self-assignment

Once the GitHub App is operational, have it self-assign to issues it is actively working on:

```
POST /repos/{owner}/{repo}/issues/{issue_number}/assignees
{ "assignees": ["paperclip-agents[bot]"] }
```

This makes the App visible as an assignee on active issues (showing "working on it" status) without needing the agent apps program. The bot won't appear in the picker, but will show on issues after assignment.

### Milestone M3.3: agent apps program registration

When GitHub opens the agent apps program beyond the current partner waitlist:

1. Apply for agent apps program membership
2. Register the Paperclip GitHub App as an agent app
3. Implement OAuth authorization flow
4. Appear in the native assignee/agent picker
5. Handle direct issue assignments from the picker
6. Map single-app assignment to internal Paperclip agents

### Milestone M3.4: selected machine-user pilot (only if M3.3 is delayed)

If the agent apps program remains closed:

- Pick one agent (likely a QA/reviewer agent)
- Create a machine user with least-privilege repo access
- Map webhook payloads to internal agent
- Use bot identity plugin for all writes
- Document deprovisioning checklist

---

## Security rules

1. **Do not make every Paperclip agent a GitHub user up front.** Start with app-mediated labels/commands.
2. **Do not inject machine-user PATs into agent env.** Use the bot identity plugin for all writes.
3. **Fail closed on repo/owner mismatch.** A label or command in `paperclipai/paperclip` should not wake a Droidshop agent unless explicitly configured.
4. **Verify webhook signatures.** Reject unsigned or invalid payloads.
5. **Record audit mapping.** Every GitHub event should record GitHub actor, event ID, repo, issue/PR, Paperclip company, agent, run, and decision.
6. **Separate GitHub visibility from provider credential.** A machine user being assignable does not imply its token should be available to the agent.
7. **Use explicit commands for destructive actions.** `/paperclip assign` is routing. `/paperclip approve` or merge actions should remain separate and permissioned.
8. **OAuth scope minimization.** If using agent apps program, request only necessary OAuth scopes for the authorization flow.
9. **Agent apps program compliance.** Follow GitHub's security review and integration quality requirements for agent app registration.

---

## Key technical references

| Source | URL | Key fact |
|--------|-----|----------|
| GitHub Changelog: Assign issues to Copilot using the API | https://github.blog/changelog/2025-12-03-assign-issues-to-copilot-using-the-api/ | GraphQL mutations + `GraphQL-Features: issues_copilot_assignment_api_support` header |
| GitHub Changelog: Extend GitHub with agent apps | https://github.blog/changelog/2026-06-02-extend-github-with-agent-apps/ | Agent apps program, partner waitlist, third-party agents in picker |
| GitHub Changelog: Claude and Codex public preview | https://github.blog/changelog/2026-02-04-claude-and-codex-are-now-available-in-public-preview-on-github/ | Claude/Codex as partner agents, enabled per repo |
| GitHub Docs: About agent apps | https://docs.github.com/en/copilot/concepts/agents/agent-apps | Agent app architecture, OAuth, installation |
| GitHub Docs: About third-party coding agents | https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents | Partner agent enablement, subscription requirements |
| GitHub Docs: Using agent apps | https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-agent-apps | Usage flow, assignment, authorization |
| GitHub CLI issue: Assigning @copilot errors | https://github.com/cli/cli/issues/11362 | REST CLI cannot assign coding agents, needs GraphQL path |
| GitHub Community discussion | https://github.com/orgs/community/discussions/197310 | Community feedback on agent apps |

---

## Open questions

- When will GitHub open the agent apps program beyond the partner waitlist? ("Over the coming months" per June 2026 announcement)
- Can a single agent app internally route to multiple Paperclip agents, or does GitHub expect 1:1 app-to-agent mapping?
- Does the agent apps program require the repository owner to have a Copilot paid subscription, or can the app work on free-tier repos?
- Should the first GitHub App live under the user account or a new organization?
- Should Droidshop repos eventually move from `roshangautam/*` into an org to unlock team-based review routing?
- Should Paperclip issue keys be mirrored into GitHub labels/comments, or should GitHub issue links remain only in plugin metadata?
- Do we want Paperclip to support GitHub App commands as a separate plugin, or fold routing into this bot-identity plugin?

---

## Conclusion

### Direct answer to the core question

**Per-agent GitHub Apps would NOT make Paperclip agents appear in GitHub's assignee/reviewer picker lists** through any currently available self-service mechanism. The native assignee picker for coding agents is gated behind GitHub's **agent apps program** (partner waitlist, launched June 2026).

### What Claude/Codex/Copilot are using

They are using **GitHub Apps registered through the agent apps partner program**. These apps:
- Have `type: Bot` in API responses
- Are backed by GitHub App slugs (e.g., `anthropic-code-agent`, `openai-code-agent`)
- Are assigned via GraphQL mutations with the `issues_copilot_assignment_api_support` feature header
- Appear in the UI assignee picker only because they are registered agent apps on repos where the feature is enabled
- Cannot be assigned through the standard REST assignees endpoint (returns 404)

### Recommended path for Paperclip

1. **Now**: Build the GitHub App gateway with labels and slash commands (M3.1). No external dependencies.
2. **Soon**: Have the app self-assign to issues it is actively processing (M3.2). Partial visibility without program membership.
3. **When available**: Register for GitHub's agent apps program to get native picker presence (M3.3). This is the path that matches Claude/Codex.
4. **Only if needed**: Pilot a machine user for one agent if native picker UX is critical before M3.3 becomes available (M3.4).

The gap between "Paperclip app can process commands and labels" and "Paperclip appears in the assignee dropdown" is entirely controlled by GitHub's agent apps program access. There is no workaround that provides the same UX without either that program or machine user accounts.
