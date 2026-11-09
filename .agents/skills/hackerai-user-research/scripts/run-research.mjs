#!/usr/bin/env node

import { open, link, rename, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

import { buildResearchCohort, CohortValidationError } from "./build-cohort.mjs";

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

export class ResearchRunnerError extends Error {}

function usage() {
  console.log(`Usage:
  node run-research.mjs --payload <file|-> [--handle <file>] [--cohort <file>] [--no-wait]
  node run-research.mjs --resume <handle-file> [--no-wait]
  node run-research.mjs --status <handle-file>

Stdin requires --handle. File input defaults to <payload>.run.json.
Handles contain no payload or credentials. Preserve the handle to recover safely.
The production gateway key is loaded from ~/.config/hackerai/pm-research.key,
then HACKERAI_PM_USER_RESEARCH_KEY only when that file is absent.`);
}

function validateResearchKey(value) {
  const key = value.trim();
  if (!key || key.length > MAX_KEY_BYTES || !/^[\x21-\x7e]+$/.test(key)) {
    throw new ResearchRunnerError(
      "Research gateway key must be a nonempty single token",
    );
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
      throw new ResearchRunnerError(
        "Cannot read the local PM research key file",
      );
    }
  }

  if (keyFile) {
    try {
      const metadata = await keyFile.stat();
      if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
        throw new ResearchRunnerError(
          "Local PM research key must be an owner-only regular file (mode 600)",
        );
      }
      if (metadata.size > MAX_KEY_BYTES) {
        throw new ResearchRunnerError(
          "Local PM research key file is larger than 4 KiB",
        );
      }
      return validateResearchKey(await keyFile.readFile("utf8"));
    } finally {
      await keyFile.close();
    }
  }

  if (env.HACKERAI_PM_USER_RESEARCH_KEY?.trim()) {
    return validateResearchKey(env.HACKERAI_PM_USER_RESEARCH_KEY);
  }
  throw new ResearchRunnerError(
    "Research gateway key not found: checked ~/.config/hackerai/pm-research.key and HACKERAI_PM_USER_RESEARCH_KEY",
  );
}

export function parseArgs(argv) {
  const args = { wait: true };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") return { help: true };
    if (seen.has(flag)) throw new ResearchRunnerError("Repeated runner option");
    seen.add(flag);
    if (flag === "--no-wait") {
      args.wait = false;
      continue;
    }
    const field = {
      "--payload": "payloadPath",
      "--handle": "handlePath",
      "--cohort": "cohortPath",
      "--resume": "resumePath",
      "--status": "statusPath",
    }[flag];
    if (!field || !argv[i + 1] || argv[i + 1].startsWith("--"))
      throw new ResearchRunnerError("Invalid runner options; use --help");
    args[field] = argv[++i];
  }
  if (
    [args.payloadPath, args.resumePath, args.statusPath].filter(Boolean)
      .length !== 1 ||
    ((args.handlePath || args.cohortPath) && !args.payloadPath) ||
    (args.payloadPath === "-" && !args.handlePath)
  ) {
    throw new ResearchRunnerError(
      "Choose --payload, --resume or --status; stdin requires --handle",
    );
  }
  args.handlePath ??=
    args.resumePath ?? args.statusPath ?? `${args.payloadPath}.run.json`;
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
  let response;
  try {
    response = await request(url, {
      ...init,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    });
  } catch {
    throw new ResearchRunnerError(
      "Research gateway request failed; preserve the handle before retrying",
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ResearchRunnerError(formatGatewayError(response.status, body));
  }
  return body;
}

export async function readProtectedJson(path, maxBytes) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > maxBytes)
      throw new ResearchRunnerError(
        "Input must be a bounded owner-only regular file",
      );
    const chunks = [];
    let size = 0;
    for await (const chunk of file.createReadStream({
      autoClose: false,
      highWaterMark: 16384,
    })) {
      size += chunk.byteLength;
      if (size > maxBytes)
        throw new ResearchRunnerError("Input exceeds size limit");
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    try {
      return JSON.parse(data.toString("utf8"));
    } catch {
      throw new ResearchRunnerError("Input must contain valid JSON");
    }
  } finally {
    await file?.close();
  }
}

export async function readPayload(args, input) {
  if (args.payloadPath !== "-")
    return readProtectedJson(args.payloadPath, MAX_PAYLOAD_BYTES);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_PAYLOAD_BYTES)
      throw new ResearchRunnerError("Request exceeds 32 KiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ResearchRunnerError("Request must contain valid JSON");
  }
}
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const fingerprint = (payload) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(payload)))
    .digest("hex");
function validateHandle(handle) {
  if (
    !handle ||
    handle.version !== 1 ||
    !/^[a-f0-9]{64}$/.test(handle.requestHash) ||
    !/^[a-f0-9-]{36}$/.test(handle.idempotencyKey) ||
    !Number.isSafeInteger(handle.createdAt) ||
    handle.createdAt <= 0 ||
    (handle.runId !== undefined && !/^run_[A-Za-z0-9]+$/.test(handle.runId)) ||
    Object.keys(handle).some(
      (key) =>
        ![
          "version",
          "requestHash",
          "idempotencyKey",
          "createdAt",
          "runId",
        ].includes(key),
    )
  )
    throw new ResearchRunnerError("Invalid research handle");
  return handle;
}
async function loadHandle(path) {
  return validateHandle(await readProtectedJson(path, 4096));
}
async function saveProtectedJson(path, value, createOnly = false) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    // link is atomic and never overwrites an existing handle. A second process
    // sees either no handle or the complete, synced original retry identity.
    if (createOnly) await link(temporary, path);
    else await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function loadPendingRequest(path, handle) {
  const payload = await readProtectedJson(path, MAX_PAYLOAD_BYTES);
  if (fingerprint(payload) !== handle.requestHash)
    throw new ResearchRunnerError("Pending request does not match the handle");
  return payload;
}

export async function runResearch(
  args,
  {
    key,
    input = process.stdin,
    request = gatewayRequest,
    now = Date.now,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
    log = console.error,
  } = {},
) {
  let handle;
  let payload;
  const pendingPath = `${args.handlePath}.request.json`;
  if (args.payloadPath) {
    payload = await readPayload(args, input);
    if (args.cohortPath) {
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        ["userIds", "comparisonGroups", "evidenceAnchors"].some(
          (key) => key in payload,
        )
      )
        throw new ResearchRunnerError(
          "Use either explicit membership or --cohort, not both",
        );
      const spec = await readProtectedJson(args.cohortPath, 1024 * 1024);
      let cohort;
      try {
        cohort = buildResearchCohort(spec);
      } catch (error) {
        throw new ResearchRunnerError(
          error instanceof CohortValidationError
            ? `Cohort selection failed: ${error.message}`
            : "Cohort selection failed; check the documented export schema",
        );
      }
      const originalLimitations = payload.selectionLimitations ?? [];
      if (
        !Array.isArray(originalLimitations) ||
        originalLimitations.length +
          cohort.payload.selectionLimitations.length >
          8
      )
        throw new ResearchRunnerError(
          "Keep at most eight combined cohort selection limitations",
        );
      payload = {
        ...payload,
        ...cohort.payload,
        selectionLimitations: [
          ...originalLimitations,
          ...cohort.payload.selectionLimitations,
        ],
      };
      log(JSON.stringify({ cohortCoverage: cohort.coverage }));
    }
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD_BYTES)
      throw new ResearchRunnerError("Compiled request exceeds 32 KiB");
    const requestHash = fingerprint(payload);
    const proposed = {
      version: 1,
      requestHash,
      idempotencyKey: randomUUID(),
      createdAt: now(),
    };
    try {
      await saveProtectedJson(args.handlePath, proposed, true);
      handle = proposed;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      handle = await loadHandle(args.handlePath);
      if (handle.requestHash !== requestHash)
        throw new ResearchRunnerError(
          "Handle belongs to a different request; preserve its recovery files and resolve that submission before starting a new analysis",
        );
    }
  } else handle = await loadHandle(args.handlePath);
  if (!handle.runId) {
    if (args.statusPath)
      throw new ResearchRunnerError(
        "Submission outcome is unknown; use --resume to recover the saved request",
      );
      // Server idempotency expires after 24 hours. Never replay an uncertain old submission.
      if (
        now() < handle.createdAt ||
        now() - handle.createdAt >= 23 * 60 * 60 * 1000
      )
        throw new ResearchRunnerError(
          "Submission outcome is unknown and its safe retry window expired; do not replay",
        );
    if (payload === undefined) {
      try {
        payload = await loadPendingRequest(pendingPath, handle);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        // Another process may have saved the accepted run and removed the copy.
        handle = await loadHandle(args.handlePath);
        if (!handle.runId)
          throw new ResearchRunnerError(
            "Submission outcome is unknown and no saved request exists; retry the original payload with this handle",
          );
      }
    }
    if (!handle.runId) {
      // Keep the exact compiled request durable before POST, including for stdin.
      // The sidecar contains no gateway key, raw cohort query or payer mapping.
      try {
        await saveProtectedJson(pendingPath, payload, true);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await loadPendingRequest(pendingPath, handle);
      }
      const started = await request(ENDPOINT, key, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": handle.idempotencyKey,
        },
        body: JSON.stringify(payload),
      });
      if (!/^run_[A-Za-z0-9]+$/.test(started.runId))
        throw new ResearchRunnerError("Gateway returned an invalid run handle");
      handle.runId = started.runId;
      await saveProtectedJson(args.handlePath, handle);
    }
  }
  try {
    await loadPendingRequest(pendingPath, handle);
    await unlink(pendingPath);
  } catch (error) {
    if (error.code !== "ENOENT")
      log("Run ID is saved; private request sidecar cleanup needs attention.");
  }
  if (!args.wait && !args.statusPath)
    return { runId: handle.runId, status: "submitted" };
  const statusUrl = new URL(ENDPOINT);
  statusUrl.searchParams.set("runId", handle.runId);
  const deadline = now() + MAX_WAIT_MS;
  log(`Research run ${handle.runId}; waiting for result.`);
  do {
    const status = await request(statusUrl, key);
    if (args.statusPath) return status;
    if (status.status === "completed") return status.result;
    if (status.status === "failed")
      throw new ResearchRunnerError(
        "Research run failed without a shareable report",
      );
    if (now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  } while (now() < deadline);
  throw new ResearchRunnerError(
    "Timed out waiting after 35 minutes; resume using the saved handle",
  );
}
export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) return usage();
  const key = await loadResearchKey();
  const result = await runResearch(args, { key });
  console.log(JSON.stringify(result, null, 2));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof ResearchRunnerError
        ? error.message
        : "Research runner failed; preserve the handle and check protected input/credential files",
    );
    process.exitCode = 1;
  });
}
