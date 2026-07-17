import { createServer, request as createRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DEFAULT_LISTEN_HOST = "127.0.0.1";
const DEFAULT_LISTEN_PORT = 3110;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
const DEFAULT_UPSTREAM_ORIGIN = "http://127.0.0.1:3100";
const PLUGIN_ID = "roshangautam.paperclip-agent-identities";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "x-slack-signature",
  "x-slack-request-timestamp",
  "x-slack-retry-num",
  "x-slack-retry-reason",
];

const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "retry-after",
];

function sendText(response, statusCode, body, extraHeaders = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

function copyHeaders(source, names) {
  const copied = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) copied[name] = value;
  }
  return copied;
}

function proxyToPaperclip({ body, requestHeaders, response, upstreamUrl, upstreamTimeoutMs }) {
  const headers = copyHeaders(requestHeaders, FORWARDED_REQUEST_HEADERS);
  headers["content-length"] = String(body.length);

  const upstreamRequest = createRequest(
    upstreamUrl,
    {
      method: "POST",
      headers,
      timeout: upstreamTimeoutMs,
    },
    (upstreamResponse) => {
      const responseHeaders = copyHeaders(upstreamResponse.headers, FORWARDED_RESPONSE_HEADERS);
      response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
      upstreamResponse.pipe(response);
    },
  );

  upstreamRequest.on("timeout", () => {
    upstreamRequest.destroy(new Error("upstream timeout"));
  });
  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      sendText(response, 502, "Bad Gateway\n");
    } else {
      response.destroy();
    }
  });
  upstreamRequest.end(body);
}

/**
 * Creates the loopback-only adapter used for temporary Slack Events API tests.
 * The caller owns listen() and close(), which keeps tests and cleanup explicit.
 */
export function createSlackEventsAdapter(options = {}) {
  const companyId = typeof options.companyId === "string" ? options.companyId.trim() : "";
  if (!UUID_PATTERN.test(companyId)) {
    throw new Error("Slack adapter requires a valid company UUID");
  }
  if ("upstreamUrl" in options) {
    throw new Error("Slack adapter does not accept a custom upstream URL; use upstreamOrigin");
  }

  const upstreamUrl = new URL(options.upstreamOrigin ?? DEFAULT_UPSTREAM_ORIGIN);
  if (
    upstreamUrl.protocol !== "http:" ||
    upstreamUrl.hostname !== "127.0.0.1" ||
    upstreamUrl.pathname !== "/" ||
    upstreamUrl.search ||
    upstreamUrl.hash ||
    upstreamUrl.username ||
    upstreamUrl.password
  ) {
    throw new Error("Slack adapter upstream must be an http://127.0.0.1 origin");
  }
  upstreamUrl.pathname = `/api/companies/${encodeURIComponent(companyId)}/plugins/${PLUGIN_ID}/webhooks/slack-events`;

  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;

  return createServer((request, response) => {
    if (request.url !== "/events") {
      sendText(response, 404, "Not Found\n");
      return;
    }
    if (request.method !== "POST") {
      sendText(response, 405, "Method Not Allowed\n", { allow: "POST" });
      return;
    }

    let bodyBytes = 0;
    let tooLarge = false;
    const chunks = [];

    request.on("data", (chunk) => {
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buffer.length;
      if (bodyBytes > maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        sendText(response, 413, "Payload Too Large\n");
        return;
      }
      chunks.push(buffer);
    });

    request.on("end", () => {
      if (tooLarge) return;
      proxyToPaperclip({
        body: Buffer.concat(chunks, bodyBytes),
        requestHeaders: request.headers,
        response,
        upstreamUrl,
        upstreamTimeoutMs,
      });
    });

    request.on("error", () => {
      if (!response.headersSent) sendText(response, 400, "Bad Request\n");
    });
  });
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const companyId = process.env.PAPERCLIP_COMPANY_ID;
  if (!companyId?.trim()) {
    console.error("PAPERCLIP_COMPANY_ID is required");
    process.exitCode = 1;
  } else {
    const server = createSlackEventsAdapter({ companyId });
    server.listen(DEFAULT_LISTEN_PORT, DEFAULT_LISTEN_HOST, () => {
      console.log(`Slack events adapter listening on http://${DEFAULT_LISTEN_HOST}:${DEFAULT_LISTEN_PORT}/events`);
    });

    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
