import type { PluginContext } from "@paperclipai/plugin-sdk";
import { listSlackConversationKeys } from "./conversation-registry.js";

export const SLACK_QUEUE_RECOVERY_JOB_KEY = "slack-queue-recovery";

const PAGE_SIZE = 100;

/**
 * Per-tick bounds. These cap the work one sweep performs; they are deliberately
 * NOT correctness limits. Hitting a bound truncates this tick and is reported
 * through the scan summary, rather than throwing -- a throw here would abort the
 * sweep for every company ordered after the offender, and since iteration order
 * is stable those companies would be starved on every subsequent tick too.
 */
const MAX_COMPANIES_PER_TICK = 1_000;
const MAX_AGENTS_PER_COMPANY_PER_TICK = 10_000;

export type DrainSlackRecoveryQueue = (
  companyId: string,
  agentId: string,
  conversationKey: string,
) => Promise<void>;

export interface SlackRecoveryScanSummary {
  readonly companiesVisited: number;
  readonly agentsVisited: number;
  readonly conversationsVisited: number;
  readonly companiesFailed: number;
  readonly conversationsFailed: number;
  /** True when a per-tick bound truncated the sweep; the next tick resumes. */
  readonly truncated: boolean;
}

/**
 * Page through a listing to a bound. Returns `truncated: true` instead of
 * throwing when the bound is reached, so an oversized tenant degrades to
 * partial coverage rather than a total recovery outage.
 */
async function listBounded<T>(
  fetchPage: (offset: number, limit: number) => Promise<T[]>,
  maxItems: number,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  for (let offset = 0; offset < maxItems; offset += PAGE_SIZE) {
    const page = await fetchPage(offset, PAGE_SIZE);
    items.push(...page);
    if (page.length < PAGE_SIZE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

export async function recoverSlackConversationQueues(
  ctx: PluginContext,
  drainQueue: DrainSlackRecoveryQueue,
): Promise<SlackRecoveryScanSummary> {
  let companiesVisited = 0;
  let agentsVisited = 0;
  let conversationsVisited = 0;
  let companiesFailed = 0;
  let conversationsFailed = 0;
  let truncated = false;

  let companies: { id: string }[] = [];
  try {
    const listed = await listBounded(
      (offset, limit) => ctx.companies.list({ limit, offset }),
      MAX_COMPANIES_PER_TICK,
    );
    companies = listed.items;
    truncated ||= listed.truncated;
  } catch {
    // The company listing is the only genuinely unrecoverable failure: with no
    // companies there is nothing to sweep. Report it and let the next tick retry.
    ctx.logger.error("Slack ingress: queue recovery could not list companies", {});
    return {
      companiesVisited: 0,
      agentsVisited: 0,
      conversationsVisited: 0,
      companiesFailed: 1,
      conversationsFailed: 0,
      truncated: true,
    };
  }

  for (const company of companies) {
    companiesVisited += 1;
    try {
      // Isolating the whole per-company body -- including the agent listing --
      // is what stops one bad tenant from starving every tenant behind it.
      const listedAgents = await listBounded(
        (offset, limit) => ctx.agents.list({ companyId: company.id, limit, offset }),
        MAX_AGENTS_PER_COMPANY_PER_TICK,
      );
      truncated ||= listedAgents.truncated;

      for (const agent of listedAgents.items) {
        if (agent.status === "terminated") continue;
        agentsVisited += 1;
        // One registry read per agent; agents with no registered conversation
        // cost exactly this read and no conversation state round-trips.
        const conversationKeys = await listSlackConversationKeys(ctx.entities, agent.id, company.id);
        for (const conversationKey of conversationKeys) {
          conversationsVisited += 1;
          try {
            await drainQueue(company.id, agent.id, conversationKey);
          } catch {
            conversationsFailed += 1;
            ctx.logger.error("Slack ingress: scheduled queue recovery failed", {
              companyId: company.id,
              agentId: agent.id,
              conversationKey,
            });
          }
        }
      }
    } catch {
      companiesFailed += 1;
      ctx.logger.error("Slack ingress: queue recovery skipped a company for this tick", {
        companyId: company.id,
      });
    }
  }

  return {
    companiesVisited,
    agentsVisited,
    conversationsVisited,
    companiesFailed,
    conversationsFailed,
    truncated,
  };
}

export function contributeSlackQueueRecoveryJob(
  ctx: PluginContext,
  drainQueue: DrainSlackRecoveryQueue,
): void {
  ctx.jobs.register(SLACK_QUEUE_RECOVERY_JOB_KEY, async () => {
    const summary = await recoverSlackConversationQueues(ctx, drainQueue);
    // Counts only -- no Slack text, user, channel, token, session, or run IDs.
    // Saturation and starvation are otherwise invisible to operators.
    ctx.logger.info("Slack ingress: queue recovery scan complete", { ...summary });
  });
}
