import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type { WorkOS } from "@workos-inc/node";
import {
  HACKERAI_PRO_20_MONTHLY_PRICE_ID,
  PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
  PRO_20_MONTHLY_INCLUDED_USAGE_POINTS,
} from "./included-usage";
import { capCurrentCycleAllocation } from "../rate-limit/token-bucket";

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

export type Pro20UsageBackfillSummary = {
  mode: "dry-run" | "apply";
  stripeLiveMode: true;
  targetFingerprint: string;
  currentPriceActiveSubscriptions: number;
  currentPricePastDueSubscriptions: number;
  eligibleSubscriptions: number;
  eligibleUsers: number;
  unmappedActiveSubscriptions: number;
  legacyPriceActiveSubscriptions: number;
  legacyPricePastDueSubscriptions: number;
  targetIncludedUsagePoints: number;
};

export type Pro20UsageBackfillApplyResult = {
  applied: true;
  usersProcessed: number;
  bucketsCreated: number;
  pointsRemoved: number;
};

type RunPro20UsageBackfillOptions = {
  stripe: Stripe;
  workos: WorkOS;
  apply?: boolean;
  expectedSubscriptions?: number;
  expectedFingerprint?: string;
  capAllocation?: typeof capCurrentCycleAllocation;
};

type ResolvedBackfillTarget = BackfillTarget & {
  subscriptionId: string;
};

function subscriptionPeriodEnd(
  subscription: Stripe.Subscription,
  priceId: string,
) {
  const itemEnds = subscription.items.data
    .filter((item) => item.price.id === priceId)
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
): Promise<Pro20UsageBackfillApplyResult> {
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
    applied: true,
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
  priceId: string,
): Promise<{ targets: ResolvedBackfillTarget[]; unmapped: number }> {
  const targets: ResolvedBackfillTarget[] = [];
  let unmapped = 0;

  for (const subscription of subscriptions) {
    const periodEnd = subscriptionPeriodEnd(subscription, priceId);
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
      subscriptionId: subscription.id,
      periodEnd,
      userIds,
    });
  }

  return { targets, unmapped };
}

function targetFingerprint(targets: ResolvedBackfillTarget[]): string {
  const stableTargets = targets
    .map((target) => ({
      subscriptionId: target.subscriptionId,
      periodEnd: target.periodEnd,
      userIds: [...target.userIds].sort(),
    }))
    .sort((a, b) => a.subscriptionId.localeCompare(b.subscriptionId));

  return createHash("sha256")
    .update(JSON.stringify(stableTargets))
    .digest("hex");
}

/** Inspect the live write set and optionally apply the guarded Redis backfill. */
export async function runPro20UsageBackfill(
  options: RunPro20UsageBackfillOptions,
): Promise<{
  summary: Pro20UsageBackfillSummary;
  applyResult?: Pro20UsageBackfillApplyResult;
}> {
  const apply = options.apply === true;
  if (
    options.expectedSubscriptions !== undefined &&
    (!Number.isInteger(options.expectedSubscriptions) ||
      options.expectedSubscriptions < 0)
  ) {
    throw new Error("expectedSubscriptions must be a non-negative integer");
  }
  if (apply && options.expectedSubscriptions === undefined) {
    throw new Error("Apply requires expectedSubscriptions");
  }

  const [currentPrice, legacyPrice] = await Promise.all([
    options.stripe.prices.retrieve(HACKERAI_PRO_20_MONTHLY_PRICE_ID),
    options.stripe.prices.retrieve(PENTESTGPT_PRO_20_MONTHLY_PRICE_ID),
  ]);
  if (!currentPrice.livemode || !legacyPrice.livemode) {
    throw new Error("Refusing to run the Pro $20 backfill in Stripe test mode");
  }

  const [active, pastDue, legacyActive, legacyPastDue] = await Promise.all([
    listSubscriptions(
      options.stripe,
      HACKERAI_PRO_20_MONTHLY_PRICE_ID,
      "active",
    ),
    listSubscriptions(
      options.stripe,
      HACKERAI_PRO_20_MONTHLY_PRICE_ID,
      "past_due",
    ),
    listSubscriptions(
      options.stripe,
      PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
      "active",
    ),
    listSubscriptions(
      options.stripe,
      PENTESTGPT_PRO_20_MONTHLY_PRICE_ID,
      "past_due",
    ),
  ]);
  const { targets, unmapped } = await resolveTargets(
    options.stripe,
    options.workos,
    active,
    HACKERAI_PRO_20_MONTHLY_PRICE_ID,
  );
  const userTargets = groupBackfillTargets(targets);
  const fingerprint = targetFingerprint(targets);
  const summary: Pro20UsageBackfillSummary = {
    mode: apply ? "apply" : "dry-run",
    stripeLiveMode: true,
    targetFingerprint: fingerprint,
    currentPriceActiveSubscriptions: active.length,
    currentPricePastDueSubscriptions: pastDue.length,
    eligibleSubscriptions: targets.length,
    eligibleUsers: userTargets.length,
    unmappedActiveSubscriptions: unmapped,
    legacyPriceActiveSubscriptions: legacyActive.length,
    legacyPricePastDueSubscriptions: legacyPastDue.length,
    targetIncludedUsagePoints: PRO_20_MONTHLY_INCLUDED_USAGE_POINTS,
  };

  if (!apply) return { summary };
  if (!options.expectedFingerprint) {
    throw new Error("Apply requires expectedFingerprint");
  }
  if (options.expectedFingerprint !== fingerprint) {
    throw new Error(
      `Safety check failed: expected target fingerprint ${options.expectedFingerprint}, found ${fingerprint}`,
    );
  }

  const applyResult = await applyBackfill(
    {
      activeSubscriptionCount: active.length,
      expectedSubscriptions: options.expectedSubscriptions!,
      targets,
      unmapped,
    },
    options.capAllocation,
  );
  return { summary, applyResult };
}
