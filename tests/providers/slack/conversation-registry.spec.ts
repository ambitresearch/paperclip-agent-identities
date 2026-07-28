import { describe, expect, it, vi } from "vitest";
import {
  listSlackConversationKeys,
  registerSlackConversationKey,
  unregisterSlackConversationKey,
  SLACK_CONVERSATION_REGISTRY_ENTITY_TYPE,
} from "../../../src/providers/slack/ingress/conversation-registry.js";
import { recoverSlackConversationQueues } from "../../../src/providers/slack/ingress/recovery-job.js";
import { makeEntities } from "./entities-fake.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);

describe("Slack durable conversation registry", () => {
  it("registers and lists a conversation for recovery", async () => {
    const entities = makeEntities();
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);

    expect(await listSlackConversationKeys(entities, "agent-1", "co-1")).toEqual([KEY_A]);
  });

  it("is idempotent, so a re-registered conversation is not listed twice", async () => {
    const entities = makeEntities();
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);

    expect(await listSlackConversationKeys(entities, "agent-1", "co-1")).toEqual([KEY_A]);
  });

  it("never loses a conversation when two workers register concurrently", async () => {
    // This is the regression the shared-array index could not satisfy: two
    // read-modify-write workers each wrote their own appended array and the
    // later write dropped the earlier key permanently.
    const entities = makeEntities();
    await Promise.all([
      registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A),
      registerSlackConversationKey(entities, "agent-1", "co-1", KEY_B),
    ]);

    expect((await listSlackConversationKeys(entities, "agent-1", "co-1")).sort()).toEqual([KEY_A, KEY_B].sort());
  });

  it("keeps a multi-company agent's conversations isolated per company", async () => {
    const entities = makeEntities();
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);
    await registerSlackConversationKey(entities, "agent-1", "co-2", KEY_B);

    expect(await listSlackConversationKeys(entities, "agent-1", "co-1")).toEqual([KEY_A]);
    expect(await listSlackConversationKeys(entities, "agent-1", "co-2")).toEqual([KEY_B]);
  });

  it("drops a retired conversation from recovery without deleting its row", async () => {
    const entities = makeEntities();
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);
    await unregisterSlackConversationKey(entities, "agent-1", "co-1", KEY_A);

    expect(await listSlackConversationKeys(entities, "agent-1", "co-1")).toEqual([]);
  });

  it("re-registers a previously retired conversation", async () => {
    const entities = makeEntities();
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);
    await unregisterSlackConversationKey(entities, "agent-1", "co-1", KEY_A);
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);

    expect(await listSlackConversationKeys(entities, "agent-1", "co-1")).toEqual([KEY_A]);
  });

  it("persists secret-free registration data only", async () => {
    const entities = makeEntities();
    await registerSlackConversationKey(entities, "agent-1", "co-1", KEY_A);
    const [record] = await entities.list({ entityType: SLACK_CONVERSATION_REGISTRY_ENTITY_TYPE });

    expect(Object.keys(record.data).sort()).toEqual(["companyId", "conversationKey", "version"]);
  });

  it("rejects an invalid scope instead of writing an unrecoverable row", async () => {
    const entities = makeEntities();
    await expect(registerSlackConversationKey(entities, " ", "co-1", KEY_A)).rejects.toThrow(/agent ID is invalid/);
    await expect(registerSlackConversationKey(entities, "agent-1", "", KEY_A)).rejects.toThrow(/company ID is invalid/);
  });
});

function makeRecoveryCtx(options: {
  companies?: { id: string }[];
  agents?: (companyId: string) => Promise<{ id: string; status?: string }[]>;
  entities?: ReturnType<typeof makeEntities>;
} = {}) {
  const entities = options.entities ?? makeEntities();
  return {
    entities,
    companies: { list: vi.fn(async () => options.companies ?? [{ id: "co-1" }]) },
    agents: {
      list: vi.fn(async ({ companyId }: { companyId: string }) =>
        options.agents ? await options.agents(companyId) : [{ id: "agent-1", status: "idle" }]),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("Slack scheduled queue recovery scan", () => {
  it("drains every registered conversation and reports secret-free counts", async () => {
    const ctx = makeRecoveryCtx();
    await registerSlackConversationKey(ctx.entities, "agent-1", "co-1", KEY_A);
    await registerSlackConversationKey(ctx.entities, "agent-1", "co-1", KEY_B);
    const drained: string[] = [];

    const summary = await recoverSlackConversationQueues(
      ctx as never,
      async (_companyId, _agentId, conversationKey) => {
        drained.push(conversationKey);
      },
    );

    expect(drained.sort()).toEqual([KEY_A, KEY_B].sort());
    expect(summary.conversationsVisited).toBe(2);
    expect(summary.conversationsFailed).toBe(0);
    expect(summary.truncated).toBe(false);
  });

  it("skips terminated agents", async () => {
    const ctx = makeRecoveryCtx({ agents: async () => [{ id: "agent-1", status: "terminated" }] });
    await registerSlackConversationKey(ctx.entities, "agent-1", "co-1", KEY_A);
    const drain = vi.fn(async () => undefined);

    const summary = await recoverSlackConversationQueues(ctx as never, drain);

    expect(drain).not.toHaveBeenCalled();
    expect(summary.agentsVisited).toBe(0);
  });

  it("isolates a per-conversation drain failure and continues the sweep", async () => {
    const ctx = makeRecoveryCtx();
    await registerSlackConversationKey(ctx.entities, "agent-1", "co-1", KEY_A);
    await registerSlackConversationKey(ctx.entities, "agent-1", "co-1", KEY_B);
    const drained: string[] = [];

    const summary = await recoverSlackConversationQueues(ctx as never, async (_c, _a, key) => {
      if (key === KEY_A) throw new Error("poison conversation");
      drained.push(key);
    });

    expect(drained).toEqual([KEY_B]);
    expect(summary.conversationsFailed).toBe(1);
    expect(summary.conversationsVisited).toBe(2);
  });

  it("does not let one failing tenant starve the tenants ordered after it", async () => {
    // The agent listing throws for co-1. Before per-company isolation this
    // aborted the whole tick, and since iteration order is stable co-2 would
    // have been starved on every subsequent tick as well.
    const ctx = makeRecoveryCtx({
      companies: [{ id: "co-1" }, { id: "co-2" }],
      agents: async (companyId) => {
        if (companyId === "co-1") throw new Error("tenant listing unavailable");
        return [{ id: "agent-2", status: "idle" }];
      },
    });
    await registerSlackConversationKey(ctx.entities, "agent-2", "co-2", KEY_B);
    const drained: string[] = [];

    const summary = await recoverSlackConversationQueues(ctx as never, async (_c, _a, key) => {
      drained.push(key);
    });

    expect(drained).toEqual([KEY_B]);
    expect(summary.companiesFailed).toBe(1);
    expect(summary.companiesVisited).toBe(2);
  });

  it("reports truncation instead of throwing when a tenant exceeds the per-tick agent bound", async () => {
    // A full page every time means the bound is reached. The sweep must still
    // return normally so later companies are not skipped.
    const ctx = makeRecoveryCtx({
      companies: [{ id: "co-1" }],
      agents: async () => Array.from({ length: 100 }, (_unused, index) => ({ id: `agent-${index}`, status: "idle" })),
    });

    const summary = await recoverSlackConversationQueues(ctx as never, async () => undefined);

    expect(summary.truncated).toBe(true);
    expect(summary.companiesFailed).toBe(0);
  });

  it("returns a failure summary rather than throwing when companies cannot be listed", async () => {
    const ctx = makeRecoveryCtx();
    ctx.companies.list = vi.fn(async () => {
      throw new Error("company listing unavailable");
    });

    const summary = await recoverSlackConversationQueues(ctx as never, async () => undefined);

    expect(summary.companiesFailed).toBe(1);
    expect(summary.conversationsVisited).toBe(0);
  });

  it("costs one registry read for an agent with no registered conversations", async () => {
    const ctx = makeRecoveryCtx();
    const listSpy = vi.spyOn(ctx.entities, "list");

    const summary = await recoverSlackConversationQueues(ctx as never, async () => undefined);

    expect(listSpy).toHaveBeenCalledOnce();
    expect(summary.conversationsVisited).toBe(0);
  });
});
