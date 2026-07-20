import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import manifest from "../src/manifest.js";

interface AdapterModule {
  createSlackEventsAdapter(options?: {
    companyId?: string;
    upstreamOrigin?: string;
    maxBodyBytes?: number;
    upstreamTimeoutMs?: number;
  }): Server;
}

const adapterModuleUrl = new URL("../scripts/slack-events-adapter.mjs", import.meta.url).href;
const adapterScriptPath = fileURLToPath(adapterModuleUrl);
const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const EXPECTED_UPSTREAM_PATH =
  `/api/companies/${COMPANY_ID}/plugins/${manifest.id}/webhooks/slack-events`;

async function loadAdapter(): Promise<AdapterModule> {
  return (await import(adapterModuleUrl)) as AdapterModule;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("temporary Slack events adapter", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(close));
  });

  it("keeps npm scope, plugin namespace, and adapter routing aligned", () => {
    const packageMetadata: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!packageMetadata || typeof packageMetadata !== "object" || !("name" in packageMetadata)) {
      throw new TypeError("package.json must declare a package name");
    }
    const namespaceSeparator = manifest.id.indexOf(".");
    if (namespaceSeparator < 1) throw new TypeError("manifest id must include a namespace");

    const namespace = manifest.id.slice(0, namespaceSeparator);
    expect(packageMetadata.name).toBe(`@${namespace}/paperclip-agent-identities`);
    expect(EXPECTED_UPSTREAM_PATH).toContain(`/plugins/${manifest.id}/`);
  });

  it("proxies the exact body and Slack headers and preserves the upstream response", async () => {
    let receivedBody = Buffer.alloc(0);
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedUrl = "";
    const upstream = createServer((request, response) => {
      receivedUrl = request.url ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        receivedBody = Buffer.concat(chunks);
        receivedHeaders = request.headers;
        const body = "challenge-verbatim";
        response.writeHead(429, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "retry-after": "3",
        });
        response.end(body);
      });
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const { createSlackEventsAdapter } = await loadAdapter();
    const adapter = createSlackEventsAdapter({
      companyId: COMPANY_ID,
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    });
    servers.push(adapter);
    const adapterPort = await listen(adapter);

    const rawBody = Buffer.from('{"text":"line 1\\nline 2","bytes":"é"}', "utf8");
    const result = await fetch(`http://127.0.0.1:${adapterPort}/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-slack-signature": "v0=test-signature",
        "x-slack-request-timestamp": "1234567890",
        "x-slack-retry-num": "1",
        "x-slack-retry-reason": "http_timeout",
        "x-not-forwarded": "private-value",
      },
      body: rawBody,
    });

    expect(result.status).toBe(429);
    expect(result.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(result.headers.get("retry-after")).toBe("3");
    expect(await result.text()).toBe("challenge-verbatim");
    expect(receivedUrl).toBe(EXPECTED_UPSTREAM_PATH);
    expect(receivedBody.equals(rawBody)).toBe(true);
    expect(receivedHeaders["x-slack-signature"]).toBe("v0=test-signature");
    expect(receivedHeaders["x-slack-request-timestamp"]).toBe("1234567890");
    expect(receivedHeaders["x-slack-retry-num"]).toBe("1");
    expect(receivedHeaders["x-slack-retry-reason"]).toBe("http_timeout");
    expect(receivedHeaders["x-not-forwarded"]).toBeUndefined();
  });

  it("rejects every route and method except POST /events without reaching upstream", async () => {
    let upstreamCalls = 0;
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1;
      response.end("unexpected");
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const { createSlackEventsAdapter } = await loadAdapter();
    const adapter = createSlackEventsAdapter({
      companyId: COMPANY_ID,
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    });
    servers.push(adapter);
    const adapterPort = await listen(adapter);

    const wrongRoute = await fetch(`http://127.0.0.1:${adapterPort}/anything`, { method: "POST", body: "{}" });
    const wrongMethod = await fetch(`http://127.0.0.1:${adapterPort}/events`);
    const queryString = await fetch(`http://127.0.0.1:${adapterPort}/events?nope=1`, { method: "POST", body: "{}" });

    expect(wrongRoute.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect(queryString.status).toBe(404);
    expect(upstreamCalls).toBe(0);
  });

  it("bounds request bodies before making an upstream request", async () => {
    let upstreamCalls = 0;
    const upstream = createServer((_request, response) => {
      upstreamCalls += 1;
      response.end("unexpected");
    });
    servers.push(upstream);
    const upstreamPort = await listen(upstream);

    const { createSlackEventsAdapter } = await loadAdapter();
    const adapter = createSlackEventsAdapter({
      companyId: COMPANY_ID,
      upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
      maxBodyBytes: 8,
    });
    servers.push(adapter);
    const adapterPort = await listen(adapter);

    const result = await fetch(`http://127.0.0.1:${adapterPort}/events`, {
      method: "POST",
      body: "123456789",
    });

    expect(result.status).toBe(413);
    expect(await result.text()).toBe("Payload Too Large\n");
    expect(upstreamCalls).toBe(0);
  });

  it("requires a company UUID and rejects non-loopback or caller-selected routes", async () => {
    const { createSlackEventsAdapter } = await loadAdapter();

    for (const companyId of [
      undefined,
      " ",
      "company-test",
      "00000000-0000-0000-0000-000000000000",
      `${COMPANY_ID}/extra`,
      `${COMPANY_ID}%2Fextra`,
      `../${COMPANY_ID}`,
    ]) {
      expect(() => createSlackEventsAdapter({ companyId })).toThrow(/valid company UUID/);
    }
    expect(() => createSlackEventsAdapter({
      companyId: COMPANY_ID,
      upstreamOrigin: "http://localhost:3100",
    })).toThrow(/http:\/\/127\.0\.0\.1 origin/);
    expect(() => createSlackEventsAdapter({
      companyId: COMPANY_ID,
      upstreamOrigin: "http://127.0.0.1:3100/custom-route",
    })).toThrow(/http:\/\/127\.0\.0\.1 origin/);
    expect(() => createSlackEventsAdapter({
      companyId: COMPANY_ID,
      upstreamUrl: "http://127.0.0.1:3100/api/plugins/ambitresearch.paperclip-agent-identities/webhooks/slack-events",
    } as never)).toThrow(/does not accept a custom upstream URL/);
  });

  it("fails fast in CLI mode when PAPERCLIP_COMPANY_ID is missing", () => {
    const env = { ...process.env };
    delete env.PAPERCLIP_COMPANY_ID;

    const result = spawnSync(process.execPath, [adapterScriptPath], {
      env,
      encoding: "utf8",
      timeout: 2_000,
    });

    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("listening");
    expect(result.stderr).toContain("PAPERCLIP_COMPANY_ID is required");
  });
});
