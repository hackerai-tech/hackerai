#!/usr/bin/env tsx

import { config } from "dotenv";
import { resolve } from "path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

config({ path: resolve(process.cwd(), ".env.e2e") });
config({ path: resolve(process.cwd(), ".env.local") });

type Options = {
  userIds: string[];
  execute: boolean;
  deleteOrphanChatSummaries: boolean;
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
  pnpm exec tsx scripts/cleanup-deleted-user-residue.ts --user <id> --orphans --execute

Options:
  --user <id>       Deleted WorkOS user id to clean. Repeat for multiple users.
  --orphans         Include orphan chat_summaries cleanup.
  --cursor <cursor> Continue an orphan chat_summaries scan from a prior result.
  --limit <number>  Orphan chat_summaries page size. Default 500, max 1000.
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

  options.orphanNumItems = Math.min(
    Math.max(Math.round(options.orphanNumItems), 1),
    1000,
  );

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.userIds.length === 0 && !options.deleteOrphanChatSummaries) {
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
    options.deleteOrphanChatSummaries &&
    result.orphanChatSummariesContinueCursor
  ) {
    console.log(
      `Next orphan cursor: ${result.orphanChatSummariesContinueCursor}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
