#!/usr/bin/env tsx

import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { WorkOS } from "@workos-inc/node";
import { createServiceConvexClient } from "../lib/db/service-client";
import {
  dispatchNotices,
  noticeSummary,
  stdioMailSender,
  workosRecipientResolver,
  type DispatchDeps,
  type DispatcherConvex,
} from "../lib/abuse/block-notice-dispatch";

/**
 * Local dispatcher for automated abuse block notices (see
 * docs/abuse-response.md). Credentials come only from the environment and
 * must match the asserted deployment and WorkOS environment before any call.
 * Output contains case references, Message-IDs and enums only.
 */

const COMMANDS = ["dispatch", "summary"] as const;
type Command = (typeof COMMANDS)[number];
const WORKOS_ENVIRONMENTS = ["test", "live"] as const;
const USAGE = `Usage: tsx scripts/abuse-block-notices.ts <dispatch|summary> --expect-convex-url <url> [--expect-workos-env test|live] [--max <1-20>]

Environment: NEXT_PUBLIC_CONVEX_URL, CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY.
dispatch also needs WORKOS_API_KEY with --expect-workos-env, ABUSE_NOTICE_BRIDGE_DIR (the
pinned Proton Bridge helper directory), and optionally ABUSE_NOTICE_PYTHON (default
/usr/bin/python3) and ABUSE_NOTICE_MAIL_HELPER (default scripts/abuse-notices/send_block_notice.py).`;

const MESSAGES: Record<string, string> = {
  usage: USAGE,
  environment_mismatch:
    "Environment identity mismatch or missing credentials. Nothing was called.",
  failed:
    "The command did not complete. Run summary; notices that may have been sent are never resent automatically.",
};

class CliError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export type CliIo = {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
};
export type CliFactories = {
  createConvex: (url: string) => DispatcherConvex;
  createDispatchDeps: (args: {
    workosKey: string;
    bridgeDir: string;
    python: string;
    script: string;
  }) => Pick<DispatchDeps, "resolveRecipient" | "send">;
};

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
          "expect-workos-env": { type: "string" },
          max: { type: "string" },
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
    const max = values.max === undefined ? 5 : Number(values.max);
    if (
      positionals.length !== 1 ||
      !COMMANDS.includes(command) ||
      !Number.isInteger(max) ||
      max < 1 ||
      max > 20
    )
      throw new CliError("usage");
    // Explicit identity assertions precede any network call.
    const convexUrl = env.NEXT_PUBLIC_CONVEX_URL;
    const serviceKey = env.CONVEX_ABUSE_NOTICE_DISPATCH_SERVICE_KEY;
    if (
      !convexUrl ||
      !serviceKey ||
      convexUrl !== values["expect-convex-url"] ||
      serviceKey === env.CONVEX_SERVICE_ROLE_KEY
    )
      throw new CliError("environment_mismatch");
    if (command === "summary") {
      const convex = factories.createConvex(convexUrl);
      const result = await noticeSummary({ convex, serviceKey });
      io.stdout(JSON.stringify({ command, result }, null, 2));
      return 0;
    }
    const workosEnv = values["expect-workos-env"] ?? "";
    const workosKey = env.WORKOS_API_KEY;
    const bridgeDir = env.ABUSE_NOTICE_BRIDGE_DIR;
    const python = env.ABUSE_NOTICE_PYTHON || "/usr/bin/python3";
    const script =
      env.ABUSE_NOTICE_MAIL_HELPER ||
      resolve(__dirname, "abuse-notices/send_block_notice.py");
    if (
      !WORKOS_ENVIRONMENTS.includes(
        workosEnv as (typeof WORKOS_ENVIRONMENTS)[number],
      ) ||
      !workosKey?.startsWith(`sk_${workosEnv}_`) ||
      !bridgeDir ||
      !isAbsolute(bridgeDir) ||
      !isAbsolute(python) ||
      !isAbsolute(script)
    )
      throw new CliError("environment_mismatch");
    const result = await dispatchNotices(
      {
        convex: factories.createConvex(convexUrl),
        serviceKey,
        ...factories.createDispatchDeps({
          workosKey,
          bridgeDir,
          python,
          script,
        }),
        newLeaseToken: randomUUID,
        now: Date.now,
      },
      max,
    );
    io.stdout(JSON.stringify({ command, result }, null, 2));
    return 0;
  } catch (error) {
    // Provider and backend errors can include identifiers; print fixed text.
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

export function defaultFactories(): CliFactories {
  return {
    // The service client signs each RPC; the key never leaves this process.
    createConvex: (url) =>
      createServiceConvexClient(url) as unknown as DispatcherConvex,
    createDispatchDeps: ({ workosKey, bridgeDir, python, script }) => ({
      resolveRecipient: workosRecipientResolver(new WorkOS(workosKey)),
      send: stdioMailSender({ python, script, bridgeDir }),
    }),
  };
}

if (require.main === module) {
  main(
    process.argv.slice(2),
    process.env,
    {
      stdout: (line) => process.stdout.write(`${line}\n`),
      stderr: (line) => process.stderr.write(`${line}\n`),
    },
    defaultFactories(),
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
