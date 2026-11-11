#!/usr/bin/env tsx

import { fstatSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { ConvexError } from "convex/values";
import { runs } from "@trigger.dev/sdk";
import { createServiceConvexClient } from "../lib/db/service-client";
import {
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "../lib/api/agent-approval-session";
import { abuseEvidenceKeyring } from "../lib/abuse/keyring";
import {
  AbuseResponseInputError,
  applyResponse,
  importReport,
  planResponse,
  responseStatus,
  retryResponse,
  type AbuseTriggerDeps,
  type ResponseConvex,
} from "../lib/abuse/response";

/**
 * Operator CLI for confirmed abuse reports. Case data and identifiers come
 * from protected stdin; credentials come only from the process environment.
 * Output contains receipts and identifiers, never evidence text or secrets.
 */

const COMMANDS = ["import", "plan", "apply", "status", "retry"] as const;
type Command = (typeof COMMANDS)[number];
const TRIGGER_COMMANDS = new Set<Command>(["plan", "apply", "retry"]);
const KEYRING_COMMANDS = new Set<Command>(["import", "apply"]);
// Secret-key prefixes by Trigger environment; a mismatch fails before any call.
const TRIGGER_ENVIRONMENTS = ["dev", "stg", "preview", "prod"];
const MAX_INPUT_BYTES = 128 * 1024;
const USAGE = `Usage: tsx scripts/abuse-response.ts <import|plan|apply|status|retry> --expect-convex-url <url> [--expect-trigger-env dev|stg|preview|prod] < case.json

Reads one JSON object from stdin: a pipe, or a regular file readable only by its owner (chmod 600).
Environment: NEXT_PUBLIC_CONVEX_URL, CONVEX_SERVICE_ROLE_KEY; ABUSE_EVIDENCE_KEYS for import/apply;
TRIGGER_SECRET_KEY plus --expect-trigger-env for plan/apply/retry. See docs/abuse-response.md.`;

const MESSAGES: Record<string, string> = {
  usage: USAGE,
  environment_mismatch:
    "Environment identity mismatch or missing credentials. Nothing was called.",
  evidence_keys_unavailable:
    "ABUSE_EVIDENCE_KEYS is unavailable or invalid. Nothing was called.",
  unprotected_input:
    "Refusing input: pipe the JSON or redirect from a file readable only by its owner (chmod 600).",
  invalid_json: "Input is not one JSON object within the size limit.",
  invalid_input: "Input failed validation. Check the listed fields.",
  credential_in_note:
    "These fields appear to contain a credential. Describe it without the raw value.",
  historical_run_unavailable:
    "The historical run could not be read from Trigger. Nothing was changed.",
  historical_run_mismatch:
    "The historical run does not match the asserted account, chat, transport, environment or deployment. Nothing was changed.",
  ABUSE_CASE_UNAVAILABLE:
    "The case is unavailable for this action (missing, appeal, resolved, already contained, in containment or evidence deleted).",
  ABUSE_INVALID_INPUT: "The backend rejected the input format or review dates.",
  ABUSE_REVIEW_REQUIRED: "The reviewer must be an allowlisted abuse operator.",
  ABUSE_SCOPE_MISMATCH:
    "The chat is not owned by the asserted account. Nothing was changed.",
  ABUSE_ENVIRONMENT_UNVERIFIED:
    "The local environment is not recorded for the asserted account and transport. Nothing was changed.",
  ABUSE_COMPETING_CASE:
    "Another case already owns containment for this account. Use that case.",
  ABUSE_RESTRICTION_CONFLICT:
    "The case restriction is not an active support security restriction for this account. Investigate before acting.",
  ABUSE_PLAN_CHANGED:
    "The case or account changed after planning. Run plan again and review the new digest.",
  ABUSE_RESPONSE_EXISTS:
    "A different response is already recorded for this case. Use status or retry.",
  ABUSE_RESPONSE_LEASE_LOST:
    "Another operation owns this response or its lease expired. Run status, then retry.",
  ABUSE_IMPORT_CONFLICT:
    "A case with this reference already exists with different content.",
};
const NOT_CONFIRMED =
  "The command was not confirmed. Run status to inspect recorded progress; restrictions remain until explicitly resolved.";

class CliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type CliIo = {
  readInput: () => Promise<unknown>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};
export type CliFactories = {
  createConvex: (url: string) => ResponseConvex;
  trigger: AbuseTriggerDeps;
  newOperationToken: () => string;
};

/** Accept a pipe or an owner-only regular file; reject terminals and shared files. */
export function assertProtectedInput(stat: {
  isFile(): boolean;
  isFIFO(): boolean;
  mode: number;
}) {
  if (stat.isFile() ? (stat.mode & 0o077) !== 0 : !stat.isFIFO())
    throw new CliError("unprotected_input");
}

async function readProtectedStdin(): Promise<unknown> {
  assertProtectedInput(fstatSync(0));
  const data = readFileSync(0);
  if (data.length > MAX_INPUT_BYTES) throw new CliError("invalid_json");
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    throw new CliError("invalid_json");
  }
}

function failure(error: unknown) {
  if (error instanceof CliError) return { message: MESSAGES[error.code] };
  if (error instanceof AbuseResponseInputError)
    return {
      message: MESSAGES[error.code],
      ...(error.fields.length ? { fields: error.fields } : {}),
    };
  if (
    error instanceof ConvexError &&
    error.data &&
    typeof error.data === "object" &&
    typeof error.data.code === "string" &&
    MESSAGES[error.data.code]
  )
    return { code: error.data.code, message: MESSAGES[error.data.code] };
  // Provider and storage errors can include evidence or identifiers.
  return { message: NOT_CONFIRMED };
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  factories: CliFactories,
): Promise<number> {
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
          "expect-convex-url": { type: "string" },
          "expect-trigger-env": { type: "string" },
          help: { type: "boolean", default: false },
        },
      });
    } catch {
      throw new CliError("usage");
    }
    const { values, positionals } = parsed;
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    const command = positionals[0] as Command;
    if (positionals.length !== 1 || !COMMANDS.includes(command))
      throw new CliError("usage");
    // Explicit identity assertions precede reading input or any network call.
    const convexUrl = env.NEXT_PUBLIC_CONVEX_URL;
    const serviceKey = env.CONVEX_SERVICE_ROLE_KEY;
    if (!convexUrl || !serviceKey || convexUrl !== values["expect-convex-url"])
      throw new CliError("environment_mismatch");
    if (TRIGGER_COMMANDS.has(command)) {
      const expected = values["expect-trigger-env"] ?? "";
      if (
        !TRIGGER_ENVIRONMENTS.includes(expected) ||
        !env.TRIGGER_SECRET_KEY?.startsWith(`tr_${expected}_`)
      )
        throw new CliError("environment_mismatch");
    }
    if (KEYRING_COMMANDS.has(command)) {
      try {
        abuseEvidenceKeyring();
      } catch {
        throw new CliError("evidence_keys_unavailable");
      }
    }
    const input = await io.readInput();
    const deps = {
      convex: factories.createConvex(convexUrl),
      serviceKey,
      convexUrl,
      ...factories.trigger,
    };
    const result =
      command === "import"
        ? await importReport(deps, input)
        : command === "plan"
          ? await planResponse(deps, input)
          : command === "apply"
            ? await applyResponse(deps, input, factories.newOperationToken())
            : command === "retry"
              ? await retryResponse(deps, input, factories.newOperationToken())
              : await responseStatus(deps, input);
    io.stdout(JSON.stringify({ command, result }, null, 2));
    return 0;
  } catch (error) {
    io.stderr(JSON.stringify(failure(error)));
    return 1;
  }
}

export function defaultFactories(): CliFactories {
  return {
    // The service client signs each RPC; the reusable key never leaves this process.
    createConvex: (url) => createServiceConvexClient(url),
    trigger: {
      retrieveRun: (runId) => runs.retrieve(runId),
      cancelRun: cancelAgentTriggerRun,
      closeApprovalSession: closeAgentApprovalSession,
    },
    newOperationToken: randomUUID,
  };
}

if (require.main === module) {
  main(
    process.argv.slice(2),
    process.env,
    {
      readInput: readProtectedStdin,
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    },
    defaultFactories(),
  ).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write(`${JSON.stringify({ message: NOT_CONFIRMED })}\n`);
      process.exitCode = 1;
    },
  );
}
