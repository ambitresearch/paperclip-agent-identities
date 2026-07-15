// tests/worker-webhook-dispatch.spec.ts
//
// Covers the generic `onWebhook` dispatch in src/worker.ts: a provider that
// declares a webhook endpoint (`webhooks()`) but has no `handleWebhook`
// implementation must fail loud, not silently drop (and implicitly ack) the
// delivery. Reviewed by Copilot on PR #81 (DRO-1005 / DRO-1099).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";

const declaration = { endpointKey: "no-handler-endpoint", displayName: "No Handler", description: "test" };

vi.mock("../src/providers/index.js", () => ({
  createProviderRegistry: () => ({
    webhooks: () => [{ declaration, provider: { id: "no-handler", handleWebhook: undefined } }],
    enabled: () => [],
    toolsEnabled: () => [],
    liveTools: () => [],
    all: () => [],
    get: () => undefined,
  }),
}));

describe("worker onWebhook dispatch", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("fails loud when a provider declares a webhook endpoint but has no handleWebhook implementation", async () => {
    const manifestModule = await import("../src/manifest.js");
    const workerModule = await import("../src/worker.js");
    const manifest = manifestModule.default;
    const plugin = workerModule.default;

    const harness = createTestHarness({ manifest, capabilities: [...manifest.capabilities] });
    await plugin.definition.setup(harness.ctx);

    await expect(
      plugin.definition.onWebhook!({ endpointKey: "no-handler-endpoint", rawBody: "{}", headers: {} } as never),
    ).rejects.toThrow(/no-handler-endpoint.*no handleWebhook implementation/i);
  });
});
