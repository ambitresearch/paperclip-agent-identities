import type {
  ParamsValidation,
  ProviderToolExecution,
  ProviderToolSpec,
  ResourceReference
} from "../../../core/provider-contract.js";
import type { GitHubAgentIdentity } from "../config.js";
import {
  githubBotWhoamiToolMetadata,
  githubBotWhoamiToolName
} from "../../../shared/github-bot-whoami-tool.js";

export const githubWhoamiToolSpec: ProviderToolSpec<GitHubAgentIdentity, ResourceReference> = {
  name: githubBotWhoamiToolName,
  metadata: githubBotWhoamiToolMetadata,
  requiresCredential: false,
  validateParams(_raw: unknown): ParamsValidation {
    return { ok: true, params: {} };
  },
  async perform(
    execution: ProviderToolExecution<GitHubAgentIdentity, ResourceReference>
  ): Promise<unknown> {
    const identity = execution.identity.identity;
    return {
      content: `Configured GitHub identity: ${identity.label} (@${identity.githubUsername}).`,
      data: {
        label: identity.label,
        githubUsername: identity.githubUsername,
        hasCommitName: Boolean(identity.commitName),
        hasCommitEmail: Boolean(identity.commitEmail)
      }
    };
  }
};
