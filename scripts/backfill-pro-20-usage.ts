#!/usr/bin/env tsx

import { config } from "dotenv";
import { resolve } from "path";
import Stripe from "stripe";
import { WorkOS } from "@workos-inc/node";
import { runPro20UsageBackfill } from "../lib/billing/pro-20-usage-backfill";

export {
  applyBackfill,
  groupBackfillTargets,
  type BackfillTarget,
} from "../lib/billing/pro-20-usage-backfill";

type Options = {
  apply: boolean;
  envFile: string;
  expectedSubscriptions?: number;
};

function printUsage() {
  console.log(`
Backfill the current-cycle included usage for active grandfathered $20 Pro subscriptions.

Dry-run is the default. Apply requires the exact subscription count printed by
the immediately preceding dry-run.

Usage:
  pnpm exec tsx scripts/backfill-pro-20-usage.ts --env-file=/tmp/hackerai-production.env
  pnpm exec tsx scripts/backfill-pro-20-usage.ts --env-file=/tmp/hackerai-production.env --apply --expected-subscriptions=105

Options:
  --env-file <path>                Environment file. Default: .env.local
  --apply                          Cap live Redis buckets at $20 of usage.
  --expected-subscriptions <count> Required with --apply.
  --help                           Show this message.
`);
}

export function parseBackfillArgs(argv: string[]): Options {
  const options: Options = {
    apply: false,
    envFile: ".env.local",
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--apply") {
      options.apply = true;
      continue;
    }
    if (arg === "--env-file") {
      const value = argv[++index];
      if (!value) throw new Error("--env-file requires a value");
      options.envFile = value;
      continue;
    }
    if (arg.startsWith("--env-file=")) {
      options.envFile = arg.slice("--env-file=".length);
      continue;
    }
    if (arg === "--expected-subscriptions") {
      const value = argv[++index];
      if (!value) throw new Error("--expected-subscriptions requires a value");
      options.expectedSubscriptions = Number(value);
      continue;
    }
    if (arg.startsWith("--expected-subscriptions=")) {
      options.expectedSubscriptions = Number(
        arg.slice("--expected-subscriptions=".length),
      );
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (
    options.expectedSubscriptions !== undefined &&
    (!Number.isInteger(options.expectedSubscriptions) ||
      options.expectedSubscriptions < 0)
  ) {
    throw new Error("--expected-subscriptions must be a non-negative integer");
  }
  if (options.apply && options.expectedSubscriptions === undefined) {
    throw new Error("--apply requires --expected-subscriptions");
  }

  return options;
}

async function main() {
  const options = parseBackfillArgs(process.argv.slice(2));
  config({ path: resolve(process.cwd(), options.envFile), override: true });

  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  const workosApiKey = process.env.WORKOS_API_KEY;
  const workosClientId = process.env.WORKOS_CLIENT_ID;
  if (!stripeSecretKey || !workosApiKey || !workosClientId) {
    throw new Error(
      "STRIPE_SECRET_KEY, WORKOS_API_KEY, and WORKOS_CLIENT_ID must be set",
    );
  }
  if (
    options.apply &&
    (!process.env.UPSTASH_REDIS_REST_URL ||
      !process.env.UPSTASH_REDIS_REST_TOKEN)
  ) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must be set with --apply",
    );
  }

  const stripe = new Stripe(stripeSecretKey);
  const workos = new WorkOS(workosApiKey, { clientId: workosClientId });
  const result = await runPro20UsageBackfill({
    stripe,
    workos,
    apply: options.apply,
    expectedSubscriptions: options.expectedSubscriptions,
  });
  const { summary } = result;
  console.log(JSON.stringify(summary, null, 2));

  if (!options.apply) {
    console.log(
      `Dry-run only. Re-run with --apply --expected-subscriptions=${summary.currentPriceActiveSubscriptions} after reviewing these counts.`,
    );
    return;
  }

  console.log(JSON.stringify(result.applyResult, null, 2));
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
