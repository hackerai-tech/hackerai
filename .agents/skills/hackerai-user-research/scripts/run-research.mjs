#!/usr/bin/env node

import { open, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

const ENDPOINT = "https://hackerai.co/api/internal/user-research";
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 35 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const MAX_KEY_BYTES = 4096;
const MAX_REPORTED_ISSUES = 8;
const MAX_ISSUE_PATH_SEGMENTS = 8;
const MAX_ISSUE_PATH_SEGMENT_CHARS = 64;
const ALLOWED_GATEWAY_ERROR_CODES = new Set([
  "invalid_payload",
  "payload_too_large",
  "invalid_json",
  "invalid_idempotency_key",
  "unauthorized",
  "research_gateway_unavailable",
  "research_run_start_failed",
  "invalid_run_id",
  "run_not_found",
  "research_run_output_invalid",
  "research_run_failed",
  "research_run_status_failed",
]);
const ISSUE_MESSAGES = {
  invalid_type: "has an invalid type",
  too_small: "is below the allowed minimum",
  too_big: "exceeds the allowed maximum",
  invalid_format: "has an invalid format",
  invalid_value: "has an unsupported value",
  unrecognized_keys: "contains unsupported fields",
  custom: "failed validation",
};

function usage() {
  console.log(`Usage: node run-research.mjs --payload /secure/path/request.json [--no-wait]

Scoped PM research gateway key (checked in order):
  ~/.config/hackerai/pm-research.key  Owner-only local key file
  HACKERAI_PM_USER_RESEARCH_KEY       Environment fallback when no file exists`);
}

function validateResearchKey(value) {
  const key = value.trim();
  if (!key || key.length > MAX_KEY_BYTES || !/^[\x21-\x7e]+$/.test(key)) {
    throw new Error("Research gateway key must be a nonempty single token");
  }
  return key;
}

export async function loadResearchKey({
  env = process.env,
  homeDir = homedir(),
} = {}) {
  const keyPath = join(homeDir, ".config", "hackerai", "pm-research.key");
  let keyFile;
  try {
    keyFile = await open(keyPath, "r");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Cannot read the local PM research key file");
    }
  }

  if (keyFile) {
    try {
      const metadata = await keyFile.stat();
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
        throw new Error(
          "Local PM research key must be an owner-only regular file (mode 600)",
        );
      }
      if (metadata.size > MAX_KEY_BYTES) {
        throw new Error("Local PM research key file is larger than 4 KiB");
      }
      return validateResearchKey(await keyFile.readFile("utf8"));
    } finally {
      await keyFile.close();
    }
  }

  if (env.HACKERAI_PM_USER_RESEARCH_KEY?.trim()) {
    return validateResearchKey(env.HACKERAI_PM_USER_RESEARCH_KEY);
  }
  throw new Error(
    "Research gateway key not found: checked ~/.config/hackerai/pm-research.key and HACKERAI_PM_USER_RESEARCH_KEY",
  );
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

/** Format a bounded gateway failure without reflecting rejected input. */
export function formatGatewayError(status, body) {
  const code = ALLOWED_GATEWAY_ERROR_CODES.has(body?.error)
    ? body.error
    : "request_failed";
  const issues = Array.isArray(body?.issues)
    ? body.issues.slice(0, MAX_REPORTED_ISSUES).flatMap((issue) => {
        if (!issue || typeof issue !== "object") return [];
        const path = Array.isArray(issue.path)
          ? issue.path
              .slice(0, MAX_ISSUE_PATH_SEGMENTS)
              .flatMap((part) => {
                if (Number.isInteger(part) && part >= 0 && part <= 999) {
                  return [String(part)];
                }
                if (
                  typeof part === "string" &&
                  part.length <= MAX_ISSUE_PATH_SEGMENT_CHARS &&
                  /^[A-Za-z][A-Za-z0-9_]*$/.test(part)
                ) {
                  return [part];
                }
                return ["field"];
              })
              .join(".")
          : "";
        const message = ISSUE_MESSAGES[issue.code] ?? "failed validation";
        return [`${path || "payload"}: ${message}`];
      })
    : [];
  const details = issues.length > 0 ? ` (${issues.join("; ")})` : "";
  return `Research gateway returned ${status}: ${code}${details}`;
}

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
    throw new Error(formatGatewayError(response.status, body));
  }
  return body;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const key = await loadResearchKey();

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
