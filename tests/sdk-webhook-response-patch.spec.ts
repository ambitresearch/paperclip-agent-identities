import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createNotification,
  createRequest,
  createSuccessResponse,
  definePlugin,
  isJsonRpcRequest,
  isJsonRpcResponse,
  parseMessage,
  serializeMessage,
  startWorkerRpcHost,
  type JsonRpcResponse,
} from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";

describe("patched plugin SDK RPC", () => {
  it("preserves the webhook HTTP status and body in the JSON-RPC result", async () => {
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const plugin = definePlugin({
      async setup() {},
      async onWebhook() {
        return { status: 401, body: { error: "unauthorized" } };
      },
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    const response = new Promise<JsonRpcResponse>((resolve) => {
      hostReadline.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcResponse(message)) resolve(message);
      });
    });

    try {
      hostToWorker.write(serializeMessage(createRequest("handleWebhook", {
        endpointKey: "slack-events",
        headers: {},
        rawBody: "{}",
        requestId: "rpc-webhook-response-test",
      }, "host-1")));

      await expect(response).resolves.toMatchObject({
        id: "host-1",
        result: { status: 401, body: { error: "unauthorized" } },
      });
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("forwards company-scoped config and exact-bound secret operations", async () => {
    const companyId = "00000000-0000-4000-8000-0000000000a1";
    const secretRef = {
      type: "secret_ref" as const,
      secretId: "00000000-0000-4000-8000-000000000012",
      version: "latest" as const,
    };
    const configPath = "identities.agent-slack.slack.credentials.signingSecret";
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const calls: Array<{ method: string; params: unknown }> = [];
    const plugin = definePlugin({
      async setup(ctx) {
        await expect(ctx.config.get(companyId)).resolves.toEqual({ identities: {} });
        await ctx.config.patchSecretRefs({
          companyId,
          path: ["identities", "agent-slack", "slack"],
          value: { credentials: { signingSecret: secretRef } },
        });
        await expect(ctx.secrets.resolve(secretRef, { companyId, configPath })).resolves.toBe("resolved-secret");
      },
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    const initialized = new Promise<JsonRpcResponse>((resolve) => {
      hostReadline.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcRequest(message)) {
          calls.push({ method: message.method, params: message.params });
          const result = message.method === "config.get"
            ? { identities: {} }
            : message.method === "secrets.resolve"
              ? "resolved-secret"
              : null;
          hostToWorker.write(serializeMessage(createSuccessResponse(message.id, result)));
        } else if (isJsonRpcResponse(message) && message.id === "host-initialize") {
          resolve(message);
        }
      });
    });

    try {
      hostToWorker.write(serializeMessage(createRequest("initialize", {
        manifest,
        config: {},
        instanceInfo: {
          instanceId: "rpc-secure-config-test",
          hostVersion: "test",
        },
        apiVersion: 1,
      }, "host-initialize")));

      await expect(initialized).resolves.toMatchObject({
        id: "host-initialize",
        result: { ok: true },
      });
      expect(calls).toEqual([
        { method: "config.get", params: { companyId } },
        {
          method: "config.patchSecretRefs",
          params: {
            companyId,
            path: ["identities", "agent-slack", "slack"],
            value: { credentials: { signingSecret: secretRef } },
          },
        },
        {
          method: "secrets.resolve",
          params: { secretRef, companyId, configPath },
        },
      ]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });

  it("preserves invocation scope for detached agent session callbacks", async () => {
    const companyId = "00000000-0000-4000-8000-0000000000a1";
    const hostToWorker = new PassThrough();
    const workerToHost = new PassThrough();
    const hostReadline = createInterface({ input: workerToHost });
    const callbackInvocationIds: string[] = [];
    let sendSessionMessage: (() => Promise<unknown>) | undefined;
    let resolveCallback!: () => void;
    const callbackComplete = new Promise<void>((resolve) => {
      resolveCallback = resolve;
    });
    const plugin = definePlugin({
      async setup(ctx) {
        const finishSession = async () => {
          await ctx.config.get(companyId);
          resolveCallback();
        };
        sendSessionMessage = () => ctx.agents.sessions.sendMessage("session-1", companyId, {
          prompt: "hello",
          onEvent() {
            void finishSession();
          },
        });
      },
    });
    const worker = startWorkerRpcHost({ plugin, stdin: hostToWorker, stdout: workerToHost });

    const initialized = new Promise<JsonRpcResponse>((resolve) => {
      hostReadline.on("line", (line) => {
        const message = parseMessage(line);
        if (isJsonRpcRequest(message)) {
          if (message.method === "agents.sessions.sendMessage") {
            hostToWorker.write(serializeMessage(createSuccessResponse(message.id, { runId: "run-1" })));
          } else if (message.method === "config.get") {
            callbackInvocationIds.push(
              (message as { paperclipInvocationId?: string }).paperclipInvocationId ?? "",
            );
            hostToWorker.write(serializeMessage(createSuccessResponse(message.id, {})));
          }
        } else if (isJsonRpcResponse(message) && message.id === "host-initialize") {
          resolve(message);
        }
      });
    });

    try {
      hostToWorker.write(serializeMessage(createRequest("initialize", {
        manifest,
        config: {},
        instanceInfo: {
          instanceId: "rpc-session-callback-scope-test",
          hostVersion: "test",
        },
        apiVersion: 1,
      }, "host-initialize")));

      await initialized;
      expect(sendSessionMessage).toBeDefined();
      await sendSessionMessage!();
      hostToWorker.write(serializeMessage({
        ...createNotification("agents.sessions.event", {
          companyId,
          sessionId: "session-1",
          runId: "run-1",
          seq: 1,
          eventType: "done",
          stream: "system",
          message: "Run completed",
          payload: null,
        }),
        paperclipInvocation: {
          id: "session-event-invocation",
          scope: { companyId },
        },
      }));

      await callbackComplete;
      expect(callbackInvocationIds).toEqual(["session-event-invocation"]);
    } finally {
      worker.stop();
      hostReadline.close();
      hostToWorker.destroy();
      workerToHost.destroy();
    }
  });
});
