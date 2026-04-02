import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

// =============================================================================
// Card-Testing Fraud Detection (Multi-Signal)
// =============================================================================
//
// Tracks rapid payment failures per Stripe customer using a sliding window
// with four fraud signals:
//
// 1. **Weighted scoring** — `incorrect_number` counts double because Stripe
//    validates card format client-side; seeing it from the API means
//    programmatic testing. Other suspicious codes count as 1.
//
// 2. **Distinct card fingerprints** — Legitimate users retry 1-2 cards.
//    3+ unique fingerprints in one window = instant block.
//
// 3. **Decline code diversity** — Getting 3+ *different* suspicious decline
//    codes (e.g. incorrect_number + incorrect_cvc + invalid_expiry) means
//    someone is iterating card details = instant block.
//
// 4. **Account age factor** — Brand-new accounts (< 24h, no prior successful
//    charge) use a lower block threshold (3 instead of 5).

/** Sliding window duration in milliseconds (10 minutes). */
const WINDOW_MS = 10 * 60 * 1000;

/** Weighted score that triggers a block for established accounts. */
const BLOCK_THRESHOLD = 5;

/** Weighted score that triggers a block for new accounts (< 24h old). */
const NEW_ACCOUNT_BLOCK_THRESHOLD = 3;

/** Number of distinct card fingerprints that triggers an instant block. */
const FINGERPRINT_BLOCK_THRESHOLD = 3;

/** Number of distinct decline code types that triggers an instant block. */
const DECLINE_DIVERSITY_BLOCK_THRESHOLD = 4;

/** Number of recent failures that marks a customer as "suspicious" for pre-checks. */
const SUSPICIOUS_THRESHOLD = 3;

/** Maximum number of decline codes to retain per tracking record (audit trail). */
const MAX_STORED_CODES = 20;

/** Maximum number of fingerprints to retain per tracking record. */
const MAX_STORED_FINGERPRINTS = 20;

// -- Decline code weights ----------------------------------------------------

/** Decline codes that get extra weight — strong card-testing signals. */
const WEIGHTED_CODES: Record<string, number> = {
  incorrect_number: 2, // Stripe validates format client-side; this is programmatic
  incorrect_cvc: 1.5, // Iterating CVVs on a known card number
  invalid_expiry_month: 1.5,
  invalid_expiry_year: 1.5,
};

/** Default weight for suspicious codes not in the map above. */
const DEFAULT_WEIGHT = 1;

function getDeclineWeight(code: string): number {
  return WEIGHTED_CODES[code] ?? DEFAULT_WEIGHT;
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Record a suspicious payment failure for a Stripe customer.
 *
 * Evaluates four signals and returns whether the customer should be blocked.
 */
export const recordPaymentFailure = mutation({
  args: {
    serviceKey: v.string(),
    stripeCustomerId: v.string(),
    declineCode: v.string(),
    cardFingerprint: v.optional(v.string()),
    isNewAccount: v.optional(v.boolean()),
  },
  returns: v.object({
    shouldBlock: v.boolean(),
    failureCount: v.number(),
    blockReason: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const now = Date.now();
    const weight = getDeclineWeight(args.declineCode);
    const threshold = args.isNewAccount
      ? NEW_ACCOUNT_BLOCK_THRESHOLD
      : BLOCK_THRESHOLD;

    const existing = await ctx.db
      .query("payment_failure_tracking")
      .withIndex("by_customer_id", (q) =>
        q.eq("stripe_customer_id", args.stripeCustomerId),
      )
      .first();

    if (!existing) {
      // First failure for this customer — create tracking record
      const fingerprints = args.cardFingerprint ? [args.cardFingerprint] : [];
      const shouldBlock = weight >= threshold;
      await ctx.db.insert("payment_failure_tracking", {
        stripe_customer_id: args.stripeCustomerId,
        failure_count: 1,
        weighted_score: weight,
        first_failure_at: now,
        last_failure_at: now,
        decline_codes: [args.declineCode],
        distinct_fingerprints: fingerprints,
        auto_blocked: shouldBlock,
      });
      return {
        shouldBlock,
        failureCount: 1,
        blockReason: shouldBlock ? "weighted_score" : undefined,
      };
    }

    // Already blocked — no need to process further
    if (existing.auto_blocked) {
      return {
        shouldBlock: true,
        failureCount: existing.failure_count,
        blockReason: "already_blocked",
      };
    }

    // Check if the window has expired — reset if so
    const windowExpired = now - existing.first_failure_at > WINDOW_MS;

    if (windowExpired) {
      const fingerprints = args.cardFingerprint ? [args.cardFingerprint] : [];
      await ctx.db.patch(existing._id, {
        failure_count: 1,
        weighted_score: weight,
        first_failure_at: now,
        last_failure_at: now,
        decline_codes: [args.declineCode],
        distinct_fingerprints: fingerprints,
      });
      return { shouldBlock: false, failureCount: 1 };
    }

    // ---- Within the window — evaluate all signals ----

    const newCount = existing.failure_count + 1;
    const newScore = existing.weighted_score + weight;

    // Update decline codes (capped for storage)
    const codes = [...existing.decline_codes, args.declineCode].slice(
      -MAX_STORED_CODES,
    );

    // Update distinct fingerprints
    let fingerprints = existing.distinct_fingerprints;
    if (args.cardFingerprint && !fingerprints.includes(args.cardFingerprint)) {
      fingerprints = [...fingerprints, args.cardFingerprint].slice(
        -MAX_STORED_FINGERPRINTS,
      );
    }

    // --- Signal evaluation ---

    let blockReason: string | undefined;

    // Signal 1: Weighted score threshold
    if (newScore >= threshold) {
      blockReason = `weighted_score:${newScore.toFixed(1)}>=${threshold}`;
    }

    // Signal 2: Distinct card fingerprints
    if (!blockReason && fingerprints.length >= FINGERPRINT_BLOCK_THRESHOLD) {
      blockReason = `distinct_cards:${fingerprints.length}`;
    }

    // Signal 3: Decline code diversity (count unique suspicious codes in window)
    if (!blockReason) {
      const uniqueCodes = new Set(codes);
      if (uniqueCodes.size >= DECLINE_DIVERSITY_BLOCK_THRESHOLD) {
        blockReason = `code_diversity:${uniqueCodes.size}_distinct_codes`;
      }
    }

    const shouldBlock = !!blockReason;

    await ctx.db.patch(existing._id, {
      failure_count: newCount,
      weighted_score: newScore,
      last_failure_at: now,
      decline_codes: codes,
      distinct_fingerprints: fingerprints,
      auto_blocked: shouldBlock,
    });

    return { shouldBlock, failureCount: newCount, blockReason };
  },
});

// =============================================================================
// Queries
// =============================================================================

/**
 * Check whether a Stripe customer has recent suspicious payment failures.
 * Used as a pre-check in payment routes to reject requests early.
 */
export const isCustomerSuspicious = query({
  args: {
    serviceKey: v.string(),
    stripeCustomerId: v.string(),
  },
  returns: v.object({
    suspicious: v.boolean(),
    blocked: v.boolean(),
  }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const record = await ctx.db
      .query("payment_failure_tracking")
      .withIndex("by_customer_id", (q) =>
        q.eq("stripe_customer_id", args.stripeCustomerId),
      )
      .first();

    if (!record) {
      return { suspicious: false, blocked: false };
    }

    if (record.auto_blocked) {
      return { suspicious: true, blocked: true };
    }

    // Check if within the active window and above suspicious threshold
    const now = Date.now();
    const withinWindow = now - record.first_failure_at <= WINDOW_MS;
    const suspicious =
      withinWindow && record.failure_count >= SUSPICIOUS_THRESHOLD;

    return { suspicious, blocked: false };
  },
});
