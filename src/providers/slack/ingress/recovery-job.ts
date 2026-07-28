import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listSlackConversationKeys } from "./conversation-session.js";

export const SLACK_QUEUE_RECOVERY_JOB_KEY = "slack-queue-recovery";
const PAGE_SIZE = 100;
const MAX_COMPANIES = 1_000;
const MAX_AGENTS_PER_COMPANY = 10_000;

export type DrainSlackRecoveryQueue = (
  companyId: string,
  agentId: string,
  conversationKey: string,
) => Promise<void>;

async function listAllCompanies(ctx: PluginContext) {
  const companies = [];
  for (let offset = 0; offset < MAX_COMPANIES; offset += PAGE_SIZE) {
    const page = await ctx.companies.list({ limit: PAGE_SIZE, offset });
    companies.push(...page);
    if (page.length < PAGE_SIZE) return companies;
  }
  throw new Error("Slack recovery company scan exceeded its safe bound.");
}

async function listAllCompanyAgents(ctx: PluginContext, companyId: string) {
  const agents = [];
  for (let offset = 0; offset < MAX_AGENTS_PER_COMPANY; offset += PAGE_SIZE) {
    const page = await ctx.agents.list({ companyId, limit: PAGE_SIZE, offset });
    agents.push(...page);
    if (page.length < PAGE_SIZE) return agents;
  }
  throw new Error("Slack recovery agent scan exceeded its safe bound.");
}

export async function recoverSlackConversationQueues(
  ctx: PluginContext,
  drainQueue: DrainSlackRecoveryQueue,
): Promise<void> {
  for (const company of await listAllCompanies(ctx)) {
    for (const agent of await listAllCompanyAgents(ctx, company.id)) {
      if (agent.status === "terminated") continue;
      for (const conversationKey of await listSlackConversationKeys(ctx.state, agent.id, company.id)) {
        try {
          await drainQueue(company.id, agent.id, conversationKey);
        } catch {
          ctx.logger.error("Slack ingress: scheduled queue recovery failed", {
            companyId: company.id,
            agentId: agent.id,
            conversationKey,
          });
        }
      }
    }
  }
}

export function contributeSlackQueueRecoveryJob(
  ctx: PluginContext,
  drainQueue: DrainSlackRecoveryQueue,
): void {
  ctx.jobs.register(SLACK_QUEUE_RECOVERY_JOB_KEY, async () => {
    await recoverSlackConversationQueues(ctx, drainQueue);
  });
}
