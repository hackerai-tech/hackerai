#!/usr/bin/env tsx

import { config } from "dotenv";
import { resolve } from "path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

config({ path: resolve(process.cwd(), ".env.e2e") });
config({ path: resolve(process.cwd(), ".env.local"), override: true });

type Options = {
  userIds: string[];
  execute: boolean;
  deleteOrphanChatSummaries: boolean;
  orphanSubagentTable?: "subagent_events" | "subagent_work_items";
  orphanCursor?: string;
  orphanNumItems: number;
};

function printUsage() {
  console.log(`
Clean deleted-user residue from Convex.

Dry-run is the default. Pass --execute to apply the cleanup.

Usage:
  pnpm exec tsx scripts/cleanup-deleted-user-residue.ts --user <workos_user_id>
  pnpm exec tsx scripts/cleanup-deleted-user-residue.ts --orphans
  pnpm exec tsx scripts/cleanup-deleted-user-residue.ts --orphan-subagent-events
  pnpm exec tsx scripts/cleanup-deleted-user-residue.ts --orphan-subagent-work-items

Options:
  --user <id>       Deleted WorkOS user id to clean. Run once per user id.
  --orphans         Include orphan chat_summaries cleanup.
  --orphan-subagent-events     Scan subagent_events whose parent run is gone.
  --orphan-subagent-work-items Scan subagent_work_items whose parent run is gone.
  --cursor <cursor> Continue the selected orphan scan from a prior result.
  --limit <number>  Orphan page size. Default 500; subagent scans max at 100.
  --execute         Apply changes. Omit for dry-run.
  --help            Show this message.
`);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    userIds: [],
    execute: false,
    deleteOrphanChatSummaries: false,
    orphanNumItems: 500,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    if (arg === "--execute") {
      options.execute = true;
      continue;
    }

    if (arg === "--orphans") {
      options.deleteOrphanChatSummaries = true;
      continue;
    }

    if (arg === "--orphan-subagent-events") {
      options.orphanSubagentTable = "subagent_events";
      continue;
    }

    if (arg === "--orphan-subagent-work-items") {
      options.orphanSubagentTable = "subagent_work_items";
      continue;
    }

    if (arg === "--user") {
      const value = argv[++i];
      if (!value) throw new Error("--user requires a value");
      options.userIds.push(value);
      continue;
    }

    if (arg.startsWith("--user=")) {
      options.userIds.push(arg.slice("--user=".length));
      continue;
    }

    if (arg === "--cursor") {
      const value = argv[++i];
      if (!value) throw new Error("--cursor requires a value");
      options.orphanCursor = value;
      continue;
    }

    if (arg.startsWith("--cursor=")) {
      options.orphanCursor = arg.slice("--cursor=".length);
      continue;
    }

    if (arg === "--limit") {
      const value = argv[++i];
      if (!value) throw new Error("--limit requires a value");
      options.orphanNumItems = Number(value);
      continue;
    }

    if (arg.startsWith("--limit=")) {
      options.orphanNumItems = Number(arg.slice("--limit=".length));
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isFinite(options.orphanNumItems)) {
    throw new Error("--limit must be a number");
  }

  if (options.userIds.length > 1) {
    throw new Error("Run this script once per --user to keep cleanup bounded");
  }

  if (
    Number(options.deleteOrphanChatSummaries) +
      Number(options.orphanSubagentTable !== undefined) >
    1
  ) {
    throw new Error("Select only one orphan cleanup per run");
  }

  const maxOrphanNumItems = options.orphanSubagentTable ? 100 : 1000;
  options.orphanNumItems = Math.min(
    Math.max(Math.round(options.orphanNumItems), 1),
    maxOrphanNumItems,
  );

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (
    options.userIds.length === 0 &&
    !options.deleteOrphanChatSummaries &&
    !options.orphanSubagentTable
  ) {
    printUsage();
    process.exit(1);
  }

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!convexUrl || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_CONVEX_URL and CONVEX_SERVICE_ROLE_KEY must be set",
    );
  }

  const client = new ConvexHttpClient(convexUrl);
  const result = await client.mutation(
    api.userDeletion.cleanupDeletedUserResidue,
    {
      serviceKey,
      userIds: options.userIds.length > 0 ? options.userIds : undefined,
      dryRun: !options.execute,
      deleteOrphanChatSummaries: options.deleteOrphanChatSummaries,
      orphanSubagentTable: options.orphanSubagentTable,
      orphanCursor: options.orphanCursor,
      orphanNumItems: options.orphanNumItems,
    },
  );

  console.log(
    JSON.stringify(
      {
        mode: options.execute ? "execute" : "dry-run",
        ...result,
      },
      null,
      2,
    ),
  );

  if (
    (options.deleteOrphanChatSummaries &&
      result.orphanChatSummariesContinueCursor) ||
    (options.orphanSubagentTable && result.orphanSubagentRowsContinueCursor)
  ) {
    const nextCursor = options.deleteOrphanChatSummaries
      ? result.orphanChatSummariesContinueCursor
      : result.orphanSubagentRowsContinueCursor;
    console.log(`Next orphan cursor: ${nextCursor}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
