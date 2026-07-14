"use node";

import Stripe from "stripe";
import { WorkOS } from "@workos-inc/node";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { runPro20UsageBackfill } from "../lib/billing/pro-20-usage-backfill";

const APPLY_CONFIRMATION = "APPLY_PRO_20_USAGE_BACKFILL";

const summaryValidator = v.object({
  mode: v.union(v.literal("dry-run"), v.literal("apply")),
  stripeLiveMode: v.literal(true),
  targetFingerprint: v.string(),
  currentPriceActiveSubscriptions: v.number(),
  currentPricePastDueSubscriptions: v.number(),
  eligibleSubscriptions: v.number(),
  eligibleUsers: v.number(),
  unmappedActiveSubscriptions: v.number(),
  legacyPriceActiveSubscriptions: v.number(),
  legacyPricePastDueSubscriptions: v.number(),
  targetIncludedUsagePoints: v.number(),
});

const applyResultValidator = v.object({
  applied: v.literal(true),
  usersProcessed: v.number(),
  bucketsCreated: v.number(),
  pointsRemoved: v.number(),
});

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

/**
 * One-time production backfill entry point. This is internal, dry-run by
 * default, and requires both an exact live count and an explicit confirmation
 * string before it can write any Redis buckets.
 */
export const run = internalAction({
  args: {
    apply: v.optional(v.boolean()),
    expectedSubscriptions: v.optional(v.number()),
    expectedFingerprint: v.optional(v.string()),
    confirmation: v.optional(v.string()),
  },
  returns: v.object({
    summary: summaryValidator,
    applyResult: v.optional(applyResultValidator),
  }),
  handler: async (_ctx, args) => {
    const apply = args.apply === true;
    if (apply && args.confirmation !== APPLY_CONFIRMATION) {
      throw new Error(`Apply requires confirmation="${APPLY_CONFIRMATION}"`);
    }
    if (apply && !args.expectedFingerprint) {
      throw new Error("Apply requires expectedFingerprint from the dry-run");
    }
    if (apply && args.expectedSubscriptions === undefined) {
      throw new Error("Apply requires expectedSubscriptions from the dry-run");
    }
    if (
      args.expectedSubscriptions !== undefined &&
      (!Number.isInteger(args.expectedSubscriptions) ||
        args.expectedSubscriptions < 0)
    ) {
      throw new Error("expectedSubscriptions must be a non-negative integer");
    }

    const stripeSecretKey = requireEnvironment("STRIPE_SECRET_KEY");
    if (
      !stripeSecretKey.startsWith("sk_live_") &&
      !stripeSecretKey.startsWith("rk_live_")
    ) {
      throw new Error(
        "Refusing to run the Pro $20 backfill without a live Stripe key",
      );
    }

    const workosApiKey = requireEnvironment("WORKOS_API_KEY");
    if (apply && workosApiKey.startsWith("sk_test_")) {
      throw new Error(
        "Refusing to apply the Pro $20 backfill with a WorkOS test key",
      );
    }
    const workosClientId = requireEnvironment("WORKOS_CLIENT_ID");
    if (apply) {
      requireEnvironment("UPSTASH_REDIS_REST_URL");
      requireEnvironment("UPSTASH_REDIS_REST_TOKEN");
    }

    return await runPro20UsageBackfill({
      stripe: new Stripe(stripeSecretKey),
      workos: new WorkOS(workosApiKey, { clientId: workosClientId }),
      apply,
      expectedSubscriptions: args.expectedSubscriptions,
      expectedFingerprint: args.expectedFingerprint,
    });
  },
});
