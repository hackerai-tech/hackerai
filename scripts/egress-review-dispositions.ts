#!/usr/bin/env tsx

import { parseArgs } from "node:util";
import { api } from "../convex/_generated/api";
import { createServiceConvexClient } from "../lib/db/service-client";
import {
  REVIEW_DISPOSITIONS,
  type ReviewDisposition,
} from "../lib/abuse/egress-outcomes";

/**
 * Read-only review dispositions for the daily egress digest (see
 * docs/abuse-response.md). Reads a JSON array of case digests on stdin and
 * prints one JSON array of closed dispositions in the same order. It sends no
 * notice and is independent of the notice dispatcher.
 */

const MAX_DIGESTS = 100;
const MAX_STDIN_BYTES = 16 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;

const USAGE = `Usage: tsx scripts/egress-review-dispositions.ts --expect-convex-url <url> < digests.json

stdin: a JSON array of 1-${MAX_DIGESTS} unique lowercase SHA-256 case digests.
stdout: a JSON array of ${REVIEW_DISPOSITIONS.join(" | ")}, in input order.
Environment: NEXT_PUBLIC_CONVEX_URL, CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY.`;

const MESSAGES: Record<string, string> = {
  usage: USAGE,
  environment_mismatch:
    "Environment identity mismatch or missing credentials. Nothing was called.",
  invalid_input: `stdin must be a JSON array of 1-${MAX_DIGESTS} unique lowercase SHA-256 digests. Nothing was called.`,
  invalid_response: "The backend returned an unexpected response.",
  failed: "The query did not complete.",
};

class CliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type DispositionsConvex = {
  query: (reference: unknown, args: Record<string, unknown>) => Promise<any>;
};
export type CliIo = {
  stdin: AsyncIterable<Buffer | string>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};
export type CliFactories = {
  createConvex: (url: string) => DispositionsConvex;
};

async function readBounded(stream: AsyncIterable<Buffer | string>) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.length;
    if (size > MAX_STDIN_BYTES) throw new CliError("invalid_input");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseDigests(text: string): string[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CliError("invalid_input");
  }
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_DIGESTS ||
    !value.every((digest) => typeof digest === "string" && DIGEST.test(digest))
  )
    throw new CliError("invalid_input");
  if (new Set(value).size !== value.length) throw new CliError("invalid_input");
  return value as string[];
}

function checkResponse(value: unknown, length: number): ReviewDisposition[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    !value.every((status) =>
      (REVIEW_DISPOSITIONS as readonly unknown[]).includes(status),
    )
  )
    throw new CliError("invalid_response");
  return value as ReviewDisposition[];
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  factories: CliFactories,
): Promise<number> {
  try {
    let values;
    try {
      ({ values } = parseArgs({
        args: argv,
        allowPositionals: false,
        options: {
          "expect-convex-url": { type: "string" },
          help: { type: "boolean", default: false },
        },
      }));
    } catch {
      throw new CliError("usage");
    }
    if (values.help) {
      io.stdout(USAGE);
      return 0;
    }
    if (!values["expect-convex-url"]) throw new CliError("usage");
    // Explicit identity assertions precede any read or network call.
    const convexUrl = env.NEXT_PUBLIC_CONVEX_URL;
    const serviceKey = env.CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY;
    if (
      !convexUrl ||
      !serviceKey ||
      convexUrl !== values["expect-convex-url"] ||
      serviceKey === env.CONVEX_SERVICE_ROLE_KEY
    )
      throw new CliError("environment_mismatch");
    const digests = parseDigests(await readBounded(io.stdin));
    const response = await factories
      .createConvex(convexUrl)
      .query(api.abuseBlockNotices.reviewDispositions, { serviceKey, digests });
    io.stdout(JSON.stringify(checkResponse(response, digests.length)));
    return 0;
  } catch (error) {
    // Backend errors can include identifiers; print fixed text only.
    io.stderr(
      JSON.stringify({
        message:
          MESSAGES[error instanceof CliError ? error.code : "failed"] ??
          MESSAGES.failed,
      }),
    );
    return 1;
  }
}

if (require.main === module) {
  main(
    process.argv.slice(2),
    process.env,
    {
      stdin: process.stdin,
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    },
    {
      // The service client signs each RPC; the key never leaves this process.
      createConvex: (url) =>
        createServiceConvexClient(url) as unknown as DispositionsConvex,
    },
  ).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write(`${JSON.stringify({ message: MESSAGES.failed })}\n`);
      process.exitCode = 1;
    },
  );
}
