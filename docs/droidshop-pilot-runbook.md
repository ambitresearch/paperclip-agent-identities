# One-Agent Droidshop Pilot Rollout Runbook

Issue: https://github.com/roshangautam/paperclip-github-bot-identity-plugin/issues/7

## Purpose

Roll out the GitHub Bot Identity plugin for exactly one Droidshop agent. Validate bot identity, audit trail, and repo-scoping before expanding to additional agents or companies.

## Prerequisites

- Paperclip platform running with plugin support.
- The `roshangautam.paperclip-github-bot-identity` plugin built and available for install.
- Access to a low-risk `roshangautam/*` repository for testing (e.g., a sandbox or scratch repo).
- Operator has Paperclip admin access to the Droidshop company.

## Constraints

- **Do not use Roshan's personal GitHub token.** A dedicated bot account is required.
- **GitHub Sync remains separate.** This plugin handles agent push/PR identity only; it does not replace or interfere with Paperclip's sync-only GitHub Sync integration.
- **Only one agent is enabled.** All other agents and companies remain paused/unmapped until pilot verification passes.
- **Token plaintext is never visible to agents.** The token is stored as a Paperclip company secret and injected by the platform, not passed through environment variables accessible to agent shells.

---

## Step 1: Create a Dedicated GitHub Bot Account

Perform this step out-of-band (manually, outside Paperclip).

1. Create a new GitHub machine-user account (e.g., `droidshop-bot` or similar).
2. Enable 2FA on the account.
3. Add the bot account as a collaborator (write access) to the target low-risk test repository (e.g., `roshangautam/sandbox`).
4. Generate a fine-grained Personal Access Token (PAT) for the bot account with the following permissions scoped to the test repository:
   - **Contents**: Read and write (push commits, create branches).
   - **Pull requests**: Read and write (open/update PRs).
   - **Metadata**: Read-only (required by GitHub).
5. Set a short expiration (e.g., 30 days) for the pilot PAT.
6. Record the bot account username and token securely. Do not store in plaintext files, chat, or source control.

> **Important:** Do not reuse any personal account token. The bot account must be a separate identity with its own credentials.

---

## Step 2: Store the Token as a Paperclip Company Secret

1. In the Paperclip admin UI, navigate to the Droidshop company settings.
2. Add a new company secret:
   - **Key:** `GITHUB_BOT_TOKEN` (or the key expected by the plugin configuration)
   - **Value:** The PAT generated in Step 1.
3. Confirm the secret is stored encrypted and is not readable back in plaintext.
4. Do **not** bind this token as a raw `env.GITHUB_TOKEN` environment variable on any agent. The plugin will access it through the Paperclip secrets API.

---

## Step 3: Configure One Pilot Agent Mapping

1. In the plugin configuration, add a single agent mapping for the pilot agent:

   ```jsonc
   {
     "agents": [
       {
         "agentId": "<pilot-agent-paperclip-id>",
         "githubUsername": "droidshop-bot",
         "secretKey": "GITHUB_BOT_TOKEN",
         "allowedRepos": ["roshangautam/sandbox"],
         "allowedOwners": ["roshangautam"]
       }
     ]
   }
   ```

2. Do **not** add mappings for any other agent.
3. Ensure no other agent has a `GITHUB_TOKEN` environment variable binding that would bypass the plugin.

---

## Step 4: Verify Identity with `github_bot_whoami`

1. Invoke the `github_bot_whoami` tool on the pilot agent.
2. Expected output should confirm:
   - The authenticated GitHub username matches the bot account (e.g., `droidshop-bot`).
   - The token is valid and not expired.
   - The resolved identity is **not** Roshan's personal account.
3. If the output shows an unexpected identity or an error, stop and investigate before proceeding.

Example expected output:

```json
{
  "login": "droidshop-bot",
  "id": 123456789,
  "type": "User",
  "tokenScopes": ["repo:roshangautam/sandbox"]
}
```

---

## Step 5: Run Push/PR Tests Against a Low-Risk Repo

Perform these tests against the designated test repository (`roshangautam/sandbox` or equivalent):

### Test A: Branch Push

1. Have the pilot agent create a branch and push a commit (e.g., a test file or README change).
2. Verify in GitHub that:
   - The commit author is `droidshop-bot`, not Roshan or any personal account.
   - The commit appears in the repo's commit history.

### Test B: Pull Request Creation

1. Have the pilot agent open a pull request from the test branch.
2. Verify in GitHub that:
   - The PR author is `droidshop-bot`.
   - The PR metadata shows the correct author identity.

### Test C: Denied Repo Fails Closed

1. Attempt a push or PR to a repository **not** in the `allowedRepos` list.
2. Verify the plugin rejects the request with a clear error (e.g., "Repository not in allow-list").
3. Confirm no write occurred on the non-allowed repository.

---

## Step 6: Remove Raw `env.GITHUB_TOKEN` Binding for the Pilot Agent

1. Confirm the pilot agent does **not** have a `GITHUB_TOKEN` environment variable set directly.
2. If any legacy binding exists from prior configuration, remove it now.
3. Re-run `github_bot_whoami` to confirm the plugin secret path is the only active token source.
4. Verify that removing the env variable does not break the agent's ability to push/PR through the plugin.

---

## Step 7: Pause Other Agents and Companies

1. Confirm no other agent in the Droidshop company has a bot identity mapping.
2. Confirm no other company has mappings configured in this plugin.
3. Leave all non-pilot agents in their current state (no plugin-mediated GitHub access) until pilot verification is complete.

---

## Evidence to Collect Before Expansion

Before enabling additional agents or companies, collect and verify the following evidence:

| Evidence | How to verify |
|----------|---------------|
| PR author is the bot account | Check PR author field on GitHub; should show `droidshop-bot` |
| Commit author is the bot account | `git log --format="%an <%ae>"` on pushed commits |
| Audit logs exist in Paperclip | Check plugin/platform logs for push/PR events with agent ID, repo, timestamp |
| Denied repos fail closed | Attempt write to non-allowed repo; confirm rejection with no side effects |
| Token is not exposed in agent env | Inspect agent environment; confirm no `GITHUB_TOKEN` present |
| GitHub Sync remains operational | Confirm Paperclip's GitHub Sync integration continues to sync independently |
| Bot account is not Roshan's personal account | `github_bot_whoami` output shows the dedicated bot login |

---

## Rollback Steps

If any issue is detected during the pilot:

### Immediate Rollback (Stop All Plugin-Mediated Writes)

1. **Remove the agent mapping** from the plugin configuration (set `"agents": []`).
2. **Revoke the PAT** on the bot account via GitHub Settings > Developer settings > Personal access tokens.
3. **Remove the company secret** (`GITHUB_BOT_TOKEN`) from Paperclip Droidshop company settings.
4. Confirm the pilot agent can no longer push or open PRs through the plugin.

### Cleanup (If Test Artifacts Remain)

1. Close or delete any test PRs created during the pilot.
2. Delete test branches pushed to the sandbox repo.
3. Optionally remove the bot account from the repo's collaborators if the pilot is fully abandoned.

### Investigation

1. Collect plugin logs covering the incident window.
2. Check GitHub audit log for the bot account (if in an org) or repository activity log.
3. Document what failed and under what conditions.
4. Do not re-enable the pilot until the root cause is identified and addressed.

---

## Post-Pilot Expansion Criteria

Expansion to additional agents or repos requires all of the following:

1. All evidence in the table above is satisfied.
2. Pilot has been stable for a reasonable soak period (operator discretion).
3. Rollback has been tested at least once (manually trigger and confirm clean teardown).
4. No token plaintext leakage observed in logs, agent output, or UI.
5. GitHub Sync continues to operate independently without interference.

---

## What This Runbook Does NOT Cover

- Production rollout to multiple agents (separate runbook).
- GitHub App installation or webhook routing (see `docs/github-native-paperclip-agents.md`).
- Token rotation procedures (future work).
- Org-level deployments or team-based routing.
