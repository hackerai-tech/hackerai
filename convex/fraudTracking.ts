import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { validateServiceKey } from "./lib/utils";

// =============================================================================
// Card-Testing Fraud Detection (Multi-Signal)
// =============================================================================
//
// Tracks rapid payment failures per Stripe customer using a true sliding
// window with four fraud signals:
//
// 1. **Weighted scoring** — `incorrect_number` counts double because Stripe
//    validates card format client-side; seeing it from the API means
//    programmatic testing. Other suspicious codes count as 1.
//
// 2. **Distinct card fingerprints** — Legitimate users retry 1-2 cards.
//    3+ unique fingerprints in one window = instant block.
//
// 3. **Decline code diversity** — Getting 4+ *different* suspicious decline
//    codes means someone is iterating card details = instant block.
//
// 4. **Account age factor** — Brand-new accounts (< 24h, no prior successful
//    charge) use a lower block threshold (3 instead of 5).
//
// NOTE: These are exposed as public mutation/query (not internal) because they
// are called from Next.js API routes via ConvexHttpClient, which cannot invoke
// internal functions. The serviceKey arg acts as the auth gate — same pattern
// used by checkAndMarkWebhook and other service-key-gated Convex functions.

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

/** Maximum number of individual failure entries to retain (audit trail). */
const MAX_STORED_ENTRIES = 30;

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

// -- Sliding window helpers ---------------------------------------------------

interface FailureEntry {
  timestamp: number;
  declineCode: string;
  fingerprint: string | null;
  weight: number;
}

/**
 * Evaluate fraud signals over a true sliding window of recent failures.
 * Only entries within [now - WINDOW_MS, now] are considered.
 */
function evaluateWindow(
  entries: FailureEntry[],
  now: number,
  threshold: number,
): { shouldBlock: boolean; blockReason: string | undefined } {
  const windowStart = now - WINDOW_MS;
  const recent = entries.filter((e) => e.timestamp >= windowStart);

  // Signal 1: Weighted score
  const score = recent.reduce((sum, e) => sum + e.weight, 0);
  if (score >= threshold) {
    return {
      shouldBlock: true,
      blockReason: `weighted_score:${score.toFixed(1)}>=${threshold}`,
    };
  }

  // Signal 2: Distinct card fingerprints
  const fingerprints = new Set(
    recent.map((e) => e.fingerprint).filter(Boolean),
  );
  if (fingerprints.size >= FINGERPRINT_BLOCK_THRESHOLD) {
    return {
      shouldBlock: true,
      blockReason: `distinct_cards:${fingerprints.size}`,
    };
  }

  // Signal 3: Decline code diversity
  const uniqueCodes = new Set(recent.map((e) => e.declineCode));
  if (uniqueCodes.size >= DECLINE_DIVERSITY_BLOCK_THRESHOLD) {
    return {
      shouldBlock: true,
      blockReason: `code_diversity:${uniqueCodes.size}_distinct_codes`,
    };
  }

  return { shouldBlock: false, blockReason: undefined };
}

// =============================================================================
// Mutations
// =============================================================================

/**
 * Record a suspicious payment failure for a Stripe customer.
 *
 * Uses a true sliding window: all entries are stored with timestamps, and
 * only entries within the last WINDOW_MS are evaluated. Old entries outside
 * the window are pruned on each call.
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

    const newEntry: FailureEntry = {
      timestamp: now,
      declineCode: args.declineCode,
      fingerprint: args.cardFingerprint ?? null,
      weight,
    };

    const existing = await ctx.db
      .query("payment_failure_tracking")
      .withIndex("by_customer_id", (q) =>
        q.eq("stripe_customer_id", args.stripeCustomerId),
      )
      .first();

    if (!existing) {
      // First failure — create record
      const { shouldBlock, blockReason } = evaluateWindow(
        [newEntry],
        now,
        threshold,
      );
      await ctx.db.insert("payment_failure_tracking", {
        stripe_customer_id: args.stripeCustomerId,
        failure_count: 1,
        weighted_score: weight,
        first_failure_at: now,
        last_failure_at: now,
        decline_codes: [args.declineCode],
        distinct_fingerprints: args.cardFingerprint
          ? [args.cardFingerprint]
          : [],
        auto_blocked: shouldBlock,
        // Store structured entries for sliding window
        entries: JSON.stringify([newEntry]),
      });
      return { shouldBlock, failureCount: 1, blockReason };
    }

    // Already blocked — short circuit
    if (existing.auto_blocked) {
      return {
        shouldBlock: true,
        failureCount: existing.failure_count,
        blockReason: "already_blocked",
      };
    }

    // Parse stored entries, prune old ones outside the window, add new one
    const windowStart = now - WINDOW_MS;
    const storedEntries: FailureEntry[] = existing.entries
      ? JSON.parse(existing.entries)
      : [];
    const recentEntries = storedEntries.filter(
      (e) => e.timestamp >= windowStart,
    );
    recentEntries.push(newEntry);

    // Cap storage to prevent unbounded growth
    const cappedEntries = recentEntries.slice(-MAX_STORED_ENTRIES);

    // Evaluate all signals over the true sliding window
    const { shouldBlock, blockReason } = evaluateWindow(
      cappedEntries,
      now,
      threshold,
    );

    // Compute summary fields for the record
    const allFingerprints = new Set(
      cappedEntries.map((e) => e.fingerprint).filter(Boolean) as string[],
    );
    const allCodes = cappedEntries.map((e) => e.declineCode);

    await ctx.db.patch(existing._id, {
      failure_count: cappedEntries.length,
      weighted_score: cappedEntries.reduce((sum, e) => sum + e.weight, 0),
      first_failure_at:
        cappedEntries.length > 0 ? cappedEntries[0].timestamp : now,
      last_failure_at: now,
      decline_codes: allCodes.slice(-MAX_STORED_ENTRIES),
      distinct_fingerprints: [...allFingerprints],
      auto_blocked: shouldBlock,
      entries: JSON.stringify(cappedEntries),
    });

    return {
      shouldBlock,
      failureCount: cappedEntries.length,
      blockReason,
    };
  },
});

/**
 * Persist a durable block signal in Convex.
 *
 * Called BEFORE Stripe cleanup so that even if Stripe calls fail and the
 * webhook retry is skipped (idempotency claim already written), the
 * isCustomerSuspicious pre-check will still see the block.
 */
export const markCustomerAutoBlocked = mutation({
  args: {
    serviceKey: v.string(),
    stripeCustomerId: v.string(),
    reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);

    const existing = await ctx.db
      .query("payment_failure_tracking")
      .withIndex("by_customer_id", (q) =>
        q.eq("stripe_customer_id", args.stripeCustomerId),
      )
      .first();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        auto_blocked: true,
        last_failure_at: now,
      });
    } else {
      await ctx.db.insert("payment_failure_tracking", {
        stripe_customer_id: args.stripeCustomerId,
        failure_count: 0,
        weighted_score: 0,
        first_failure_at: now,
        last_failure_at: now,
        decline_codes: [args.reason],
        distinct_fingerprints: [],
        auto_blocked: true,
        entries: JSON.stringify([]),
      });
    }

    return null;
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

    // True sliding window check: count recent entries
    const now = Date.now();
    const windowStart = now - WINDOW_MS;
    const entries: FailureEntry[] = record.entries
      ? JSON.parse(record.entries)
      : [];
    const recentCount = entries.filter(
      (e) => e.timestamp >= windowStart,
    ).length;
    const suspicious = recentCount >= SUSPICIOUS_THRESHOLD;

    return { suspicious, blocked: false };
  },
});
