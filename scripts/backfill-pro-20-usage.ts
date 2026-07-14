#!/usr/bin/env tsx

import { config } from "dotenv";
import { resolve } from "path";
import Stripe from "stripe";
import { WorkOS } from "@workos-inc/node";
import {
  HACKERAI_PRO_20_MONTHLY_PRICE_ID,
  PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
  PRO_20_MONTHLY_INCLUDED_USAGE_POINTS,
} from "../lib/billing/included-usage";
import { capCurrentCycleAllocation } from "../lib/rate-limit/token-bucket";

type Options = {
  apply: boolean;
  envFile: string;
  expectedSubscriptions?: number;
};

export type BackfillTarget = {
  periodEnd: number;
  userIds: string[];
};

type UserBackfillTarget = {
  periodEnd: number;
  userId: string;
};

type ApplyBackfillOptions = {
  activeSubscriptionCount: number;
  expectedSubscriptions: number;
  targets: BackfillTarget[];
  unmapped: number;
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

function subscriptionPeriodEnd(subscription: Stripe.Subscription) {
  const itemEnds = subscription.items.data
    .map(
      (item) =>
        (item as Stripe.SubscriptionItem & { current_period_end?: number })
          .current_period_end,
    )
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    );
  if (itemEnds.length > 0) return Math.max(...itemEnds);

  const topLevelEnd = (subscription as { current_period_end?: unknown })
    .current_period_end;
  return typeof topLevelEnd === "number" &&
    Number.isFinite(topLevelEnd) &&
    topLevelEnd > 0
    ? topLevelEnd
    : undefined;
}

/** Build one deterministic target per user and reject ambiguous cycle data. */
export function groupBackfillTargets(
  targets: BackfillTarget[],
): UserBackfillTarget[] {
  const periodEndByUser = new Map<string, number>();

  for (const target of targets) {
    if (
      typeof target.periodEnd !== "number" ||
      !Number.isFinite(target.periodEnd) ||
      target.periodEnd <= 0
    ) {
      throw new Error("Safety check failed: missing subscription period end");
    }

    for (const userId of target.userIds) {
      const existingPeriodEnd = periodEndByUser.get(userId);
      if (
        existingPeriodEnd !== undefined &&
        existingPeriodEnd !== target.periodEnd
      ) {
        throw new Error(
          `Safety check failed: conflicting subscription period ends for user ${userId}`,
        );
      }
      periodEndByUser.set(userId, target.periodEnd);
    }
  }

  return [...periodEndByUser.entries()].map(([userId, periodEnd]) => ({
    userId,
    periodEnd,
  }));
}

/** Validate the full write set before applying any Redis mutations. */
export async function applyBackfill(
  options: ApplyBackfillOptions,
  capAllocation: typeof capCurrentCycleAllocation = capCurrentCycleAllocation,
) {
  const userTargets = groupBackfillTargets(options.targets);

  if (options.activeSubscriptionCount !== options.expectedSubscriptions) {
    throw new Error(
      `Safety check failed: expected ${options.expectedSubscriptions} active subscriptions, found ${options.activeSubscriptionCount}`,
    );
  }
  if (
    options.targets.length !== options.activeSubscriptionCount ||
    options.unmapped > 0
  ) {
    throw new Error(
      `Safety check failed: ${options.unmapped} active subscription(s) could not be mapped to WorkOS users and a Stripe cycle`,
    );
  }

  let bucketsCreated = 0;
  let pointsRemoved = 0;
  for (const target of userTargets) {
    const result = await capAllocation(
      target.userId,
      "pro",
      PRO_20_MONTHLY_INCLUDED_USAGE_POINTS,
      target.periodEnd,
    );
    if (result.created) bucketsCreated++;
    pointsRemoved += result.pointsRemoved;
  }

  return {
    applied: true as const,
    usersProcessed: userTargets.length,
    bucketsCreated,
    pointsRemoved,
  };
}

async function listSubscriptions(
  stripe: Stripe,
  price: string,
  status: "active" | "past_due",
): Promise<Stripe.Subscription[]> {
  const subscriptions: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;

  do {
    const page = await stripe.subscriptions.list({
      price,
      status,
      limit: 100,
      starting_after: startingAfter,
    });
    subscriptions.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (startingAfter);

  return subscriptions;
}

async function resolveTargets(
  stripe: Stripe,
  workos: WorkOS,
  subscriptions: Stripe.Subscription[],
): Promise<{ targets: BackfillTarget[]; unmapped: number }> {
  const targets: BackfillTarget[] = [];
  let unmapped = 0;

  for (const subscription of subscriptions) {
    const periodEnd = subscriptionPeriodEnd(subscription);
    if (periodEnd === undefined) {
      unmapped++;
      continue;
    }

    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;
    const customer = await stripe.customers.retrieve(customerId);
    if (customer.deleted) {
      unmapped++;
      continue;
    }

    const organizationId = customer.metadata.workOSOrganizationId;
    if (!organizationId) {
      unmapped++;
      continue;
    }

    const memberships = await workos.userManagement.listOrganizationMemberships(
      {
        organizationId,
        statuses: ["active"],
      },
    );
    const userIds = (await memberships.autoPagination()).map(
      (membership) => membership.userId,
    );
    if (userIds.length === 0) {
      unmapped++;
      continue;
    }

    targets.push({
      periodEnd,
      userIds,
    });
  }

  return { targets, unmapped };
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
  const [active, pastDue, legacyActive, legacyPastDue] = await Promise.all([
    listSubscriptions(stripe, HACKERAI_PRO_20_MONTHLY_PRICE_ID, "active"),
    listSubscriptions(stripe, HACKERAI_PRO_20_MONTHLY_PRICE_ID, "past_due"),
    listSubscriptions(stripe, PENTESTGPT_PRO_20_MONTHLY_PRICE_ID, "active"),
    listSubscriptions(stripe, PENTESTGPT_PRO_20_MONTHLY_PRICE_ID, "past_due"),
  ]);
  const { targets, unmapped } = await resolveTargets(stripe, workos, active);
  const userTargets = groupBackfillTargets(targets);

  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    currentPriceActiveSubscriptions: active.length,
    currentPricePastDueSubscriptions: pastDue.length,
    eligibleSubscriptions: targets.length,
    eligibleUsers: userTargets.length,
    unmappedActiveSubscriptions: unmapped,
    legacyPriceActiveSubscriptions: legacyActive.length,
    legacyPricePastDueSubscriptions: legacyPastDue.length,
    targetIncludedUsagePoints: PRO_20_MONTHLY_INCLUDED_USAGE_POINTS,
  };
  console.log(JSON.stringify(summary, null, 2));

  if (!options.apply) {
    console.log(
      `Dry-run only. Re-run with --apply --expected-subscriptions=${active.length} after reviewing these counts.`,
    );
    return;
  }

  const result = await applyBackfill({
    activeSubscriptionCount: active.length,
    expectedSubscriptions: options.expectedSubscriptions!,
    targets,
    unmapped,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
