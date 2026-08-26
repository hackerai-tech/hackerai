#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

const ENDPOINT = "https://hackerai.co/api/internal/user-research";
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 35 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAYLOAD_BYTES = 32 * 1024;

function usage() {
  console.log(`Usage: node run-research.mjs --payload /secure/path/request.json [--no-wait]

Required environment:
  HACKERAI_PM_USER_RESEARCH_KEY  Scoped PM research gateway key`);
}

export function parseArgs(argv) {
  const args = { wait: true, payloadPath: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true };
    if (value === "--no-wait") {
      args.wait = false;
      continue;
    }
    if (value === "--payload") {
      args.payloadPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!args.payloadPath) throw new Error("--payload is required");
  return args;
}

export function createProxyDispatcher(env = process.env) {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY;
  if (!httpProxy && !httpsProxy) return undefined;

  return new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    noProxy: env.no_proxy ?? env.NO_PROXY,
  });
}

const proxyDispatcher = createProxyDispatcher();

export async function gatewayRequest(
  url,
  key,
  init = {},
  { request = undiciFetch, dispatcher = proxyDispatcher } = {},
) {
  const response = await request(url, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(dispatcher ? { dispatcher } : {}),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "request_failed";
    throw new Error(`Research gateway returned ${response.status}: ${code}`);
  }
  return body;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const key = process.env.HACKERAI_PM_USER_RESEARCH_KEY?.trim();
  if (!key) throw new Error("HACKERAI_PM_USER_RESEARCH_KEY is required");

  const payloadStats = await stat(args.payloadPath);
  if (!payloadStats.isFile())
    throw new Error("Research request must be a file");
  if ((payloadStats.mode & 0o077) !== 0) {
    throw new Error("Research request must not be readable by group or others");
  }
  const payloadBuffer = await readFile(args.payloadPath);
  if (payloadBuffer.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("Research request is larger than 32 KiB");
  }
  const payload = JSON.parse(payloadBuffer.toString("utf8"));
  const gatewayUrl = ENDPOINT;
  const started = await gatewayRequest(gatewayUrl, key, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
    },
    body: JSON.stringify(payload),
  });

  if (typeof started.runId !== "string") {
    throw new Error("Research gateway returned an invalid run handle");
  }
  if (!args.wait) {
    console.log(JSON.stringify(started, null, 2));
    return;
  }

  console.error(`Research run ${started.runId} queued; waiting for result.`);
  const deadline = Date.now() + MAX_WAIT_MS;
  let polls = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const statusUrl = new URL(gatewayUrl);
    statusUrl.searchParams.set("runId", started.runId);
    const status = await gatewayRequest(statusUrl, key);
    if (status.status === "completed") {
      console.log(JSON.stringify(status.result, null, 2));
      return;
    }
    if (status.status === "failed") {
      throw new Error("Research run failed without a shareable report");
    }
    polls += 1;
    if (polls % 3 === 0) {
      console.error(`Research run ${started.runId} is still running.`);
    }
  }
  throw new Error("Timed out waiting for the research result after 35 minutes");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Research runner failed",
    );
    process.exitCode = 1;
  });
}
