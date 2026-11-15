import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./lib/serviceFunctions";
import type { Doc, Id } from "./_generated/dataModel";
import { validateServiceKey } from "./lib/utils";
import { convexLogger } from "./lib/logger";
import {
  extraUsageBundleCapPeriod,
  extraUsageBundlesEnabled,
  getExtraUsageBundle,
} from "../lib/billing/extra-usage-bundles";
import {
  BUNDLE_IDEMPOTENCY_REPLAY_WINDOW_MS,
  findBundleReservation,
  readBundleCapUsage,
  type BundleCapUsage,
} from "./lib/extraUsageBundleCap";

const capSnapshot = v.object({
  policyVersion: v.string(),
  periodMonth: v.string(),
  resetsAt: v.number(),
  capDollars: v.number(),
  usedDollars: v.number(),
  pendingDollars: v.number(),
  remainingDollars: v.number(),
  historyComplete: v.boolean(),
});

const pendingHold = v.union(
  v.object({
    kind: v.literal("reservation"),
    reservationId: v.id("extra_usage_bundle_reservations"),
    bundleId: v.string(),
    stripeCheckoutSessionId: v.optional(v.string()),
    stripeCustomerId: v.string(),
    createdAt: v.number(),
  }),
  v.object({
    kind: v.literal("legacy"),
    bundleId: v.string(),
    stripeCheckoutSessionId: v.string(),
  }),
);

const toSnapshot = (usage: BundleCapUsage) =>
  usage.complete
    ? {
        policyVersion: usage.policyVersion,
        periodMonth: usage.periodMonth,
        resetsAt: usage.resetsAt,
        capDollars: usage.capDollars,
        usedDollars: usage.usedDollars,
        pendingDollars: usage.pendingDollars,
        remainingDollars: usage.remainingDollars,
        historyComplete: true,
      }
    : {
        policyVersion: usage.policyVersion,
        periodMonth: usage.periodMonth,
        resetsAt: usage.resetsAt,
        capDollars: usage.capDollars,
        usedDollars: 0,
        pendingDollars: 0,
        remainingDollars: 0,
        historyComplete: false,
      };

/**
 * Monthly bundle allowance for the signed-in user. Null whenever the existing
 * bundle sales gate is closed, so callers keep their current behavior.
 * Offers with a pending checkout this period are resumable regardless of the
 * remaining allowance, since resuming takes no new allowance.
 *
 * `refresh` is ignored by the handler; clients change it to re-evaluate the
 * server clock (for example at the UTC reset). Time is never client-supplied.
 */
export const getBundleCapStatus = query({
  args: { refresh: v.optional(v.number()) },
  returns: v.union(
    v.null(),
    v.object({
      ...capSnapshot.fields,
      resumableBundleIds: v.array(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity || !extraUsageBundlesEnabled(identity.subject)) return null;
    const usage = await readBundleCapUsage(ctx, identity.subject, Date.now());
    return {
      ...toSnapshot(usage),
      resumableBundleIds: usage.complete
        ? [...new Set(usage.pendingHolds.map((hold) => hold.bundleId))]
        : [],
    };
  },
});

/** This period's pending holds, read through the bounded cap query. */
export const listPendingBundleHolds = internalQuery({
  args: { userId: v.string() },
  returns: v.array(pendingHold),
  handler: async (ctx, args) => {
    const usage = await readBundleCapUsage(ctx, args.userId, Date.now());
    return usage.complete ? usage.pendingHolds : [];
  },
});

const reservedResult = v.object({
  status: v.literal("reserved"),
  reused: v.boolean(),
  // False when Stripe must be searched rather than called with the key again.
  mayCreate: v.boolean(),
  reservationId: v.id("extra_usage_bundle_reservations"),
  createAttempts: v.number(),
  periodMonth: v.string(),
  policyVersion: v.string(),
  checkoutAttemptId: v.string(),
  createdAt: v.number(),
  stripeCheckoutSessionId: v.optional(v.string()),
  stripeCustomerId: v.string(),
  applicationOrigin: v.string(),
  returnPath: v.optional(v.string()),
  resumeAfterPurchase: v.optional(v.boolean()),
  enableExtraUsageAfterPurchase: v.optional(v.boolean()),
  cap: capSnapshot,
});

const fromReservation = (
  row: Doc<"extra_usage_bundle_reservations">,
  fields: { reused: boolean; mayCreate: boolean; createAttempts: number },
  cap: ReturnType<typeof toSnapshot>,
) => ({
  status: "reserved" as const,
  ...fields,
  reservationId: row._id,
  periodMonth: row.period_month,
  policyVersion: row.policy_version,
  checkoutAttemptId: row.checkout_attempt_id,
  createdAt: row.created_at,
  stripeCheckoutSessionId: row.stripe_checkout_session_id,
  stripeCustomerId: row.stripe_customer_id,
  applicationOrigin: row.application_origin,
  returnPath: row.return_path,
  resumeAfterPurchase: row.resume_after_purchase,
  enableExtraUsageAfterPurchase: row.enable_extra_usage_after_purchase,
  cap,
});

/**
 * Atomically hold allowance before Stripe is called. Each user has at most one
 * pending checkout per offer per period: a retry, or a new attempt for the same
 * offer, resumes that hold with its original attempt ID and Stripe inputs.
 * Consumed holds are never resumed, so a later real purchase can proceed.
 */
export const reserveBundle = internalMutation({
  args: {
    userId: v.string(),
    bundleId: v.string(),
    checkoutAttemptId: v.string(),
    stripeCustomerId: v.string(),
    applicationOrigin: v.string(),
    returnPath: v.optional(v.string()),
    resumeAfterPurchase: v.optional(v.boolean()),
    enableExtraUsageAfterPurchase: v.optional(v.boolean()),
  },
  returns: v.union(
    reservedResult,
    v.object({
      status: v.literal("legacy_pending"),
      stripeCheckoutSessionId: v.string(),
      cap: capSnapshot,
    }),
    v.object({
      status: v.literal("blocked"),
      cap: capSnapshot,
      pendingHolds: v.array(pendingHold),
    }),
    v.object({ status: v.literal("unavailable"), cap: capSnapshot }),
    v.object({ status: v.literal("attempt_conflict") }),
  ),
  handler: async (ctx, args) => {
    const bundle = getExtraUsageBundle(args.bundleId);
    const now = Date.now();
    const { periodMonth } = extraUsageBundleCapPeriod(now);

    // The attempt's mapping is authoritative: it also covers attempts that
    // resumed another attempt's checkout, whatever its status or month.
    const mapping = await ctx.db
      .query("extra_usage_bundle_attempts")
      .withIndex("by_user_attempt", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("checkout_attempt_id", args.checkoutAttemptId),
      )
      .unique();
    if (mapping && mapping.bundle_id !== bundle.id)
      return { status: "attempt_conflict" as const };
    const mapped = mapping ? await ctx.db.get(mapping.reservation_id) : null;
    let live = mapped && mapped.status !== "released" ? mapped : null;

    // Reservations created before attempt mappings existed: a new row is only
    // inserted for an attempt without a pending row, so its newest row is the
    // only one that can still be live.
    if (!live) {
      const newestForAttempt = await ctx.db
        .query("extra_usage_bundle_reservations")
        .withIndex("by_user_attempt", (q) =>
          q
            .eq("user_id", args.userId)
            .eq("checkout_attempt_id", args.checkoutAttemptId),
        )
        .order("desc")
        .first();
      // Replaying an already-paid attempt must recover that purchase, never
      // allocate a second checkout. A genuinely new purchase has a new attempt.
      live =
        newestForAttempt && newestForAttempt.status !== "released"
          ? newestForAttempt
          : null;
      if (live && live.bundle_id !== bundle.id)
        return { status: "attempt_conflict" as const };
    }
    const mapAttempt = async (
      reservationId: Id<"extra_usage_bundle_reservations">,
    ) => {
      if (!mapping) {
        await ctx.db.insert("extra_usage_bundle_attempts", {
          user_id: args.userId,
          checkout_attempt_id: args.checkoutAttemptId,
          bundle_id: bundle.id,
          reservation_id: reservationId,
          created_at: now,
          updated_at: now,
        });
      } else if (mapping.reservation_id !== reservationId) {
        // A released hold was replaced; follow the replacement.
        await ctx.db.patch(mapping._id, {
          reservation_id: reservationId,
          updated_at: now,
        });
      }
    };
    live ??= await ctx.db
      .query("extra_usage_bundle_reservations")
      .withIndex("by_user_period_status_bundle", (q) =>
        q
          .eq("user_id", args.userId)
          .eq("period_month", periodMonth)
          .eq("status", "reserved")
          .eq("bundle_id", bundle.id),
      )
      .first();

    const usage = await readBundleCapUsage(ctx, args.userId, now);
    const cap = toSnapshot(usage);

    if (live) {
      const mayCreate =
        !live.stripe_checkout_session_id &&
        now - live.created_at < BUNDLE_IDEMPOTENCY_REPLAY_WINDOW_MS;
      const createAttempts = live.create_attempts + (mayCreate ? 1 : 0);
      if (mayCreate) {
        await ctx.db.patch(live._id, {
          create_attempts: createAttempts,
          updated_at: now,
        });
      }
      await mapAttempt(live._id);
      return fromReservation(
        live,
        { reused: true, mayCreate, createAttempts },
        cap,
      );
    }

    if (!usage.complete) {
      convexLogger.error("extra_usage_bundle_cap_history_incomplete", {
        user_id: args.userId,
        period_month: usage.periodMonth,
        reason: usage.reason,
        policy_version: usage.policyVersion,
        remediation:
          "Reconcile this user's bundle reservations and purchase ledger rows for the period.",
      });
      return { status: "unavailable" as const, cap };
    }

    const legacy = usage.pendingHolds.find(
      (hold): hold is Extract<typeof hold, { kind: "legacy" }> =>
        hold.kind === "legacy" && hold.bundleId === bundle.id,
    );
    if (legacy) {
      return {
        status: "legacy_pending" as const,
        stripeCheckoutSessionId: legacy.stripeCheckoutSessionId,
        cap,
      };
    }

    if (bundle.creditDollars > usage.remainingDollars) {
      return {
        status: "blocked" as const,
        cap,
        pendingHolds: usage.pendingHolds,
      };
    }

    const reservationId = await ctx.db.insert(
      "extra_usage_bundle_reservations",
      {
        user_id: args.userId,
        period_month: usage.periodMonth,
        policy_version: usage.policyVersion,
        checkout_attempt_id: args.checkoutAttemptId,
        bundle_id: bundle.id,
        credit_dollars: bundle.creditDollars,
        paid_dollars: bundle.paidDollars,
        status: "reserved",
        stripe_customer_id: args.stripeCustomerId,
        application_origin: args.applicationOrigin,
        return_path: args.returnPath,
        resume_after_purchase: args.resumeAfterPurchase,
        enable_extra_usage_after_purchase: args.enableExtraUsageAfterPurchase,
        create_attempts: 1,
        created_at: now,
        updated_at: now,
      },
    );
    await mapAttempt(reservationId);
    const inserted = (await ctx.db.get(reservationId))!;
    return fromReservation(
      inserted,
      { reused: false, mayCreate: true, createAttempts: 1 },
      cap,
    );
  },
});

/** Link the Stripe session created for a hold. False if the hold is gone. */
export const attachBundleSession = internalMutation({
  args: {
    reservationId: v.id("extra_usage_bundle_reservations"),
    stripeCheckoutSessionId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation || reservation.status === "released") return false;
    if (reservation.stripe_checkout_session_id) {
      return (
        reservation.stripe_checkout_session_id === args.stripeCheckoutSessionId
      );
    }
    await ctx.db.patch(reservation._id, {
      stripe_checkout_session_id: args.stripeCheckoutSessionId,
      updated_at: Date.now(),
    });
    return true;
  },
});

type ReleaseReason =
  | "stripe_session_expired"
  | "stripe_async_payment_failed"
  | "stripe_payment_canceled"
  | "stripe_create_rejected";

/**
 * Release a hold only for a Stripe-confirmed unpaid outcome. A linked hold is
 * released for its own session. An unlinked hold is released only when Stripe
 * rejected the first and only create call for its key; once a create has been
 * retried, an earlier call may have produced a payable session.
 * Legacy sessions without a hold are marked unpaid in the purchase ledger.
 */
async function releaseBundleHoldInternal(
  ctx: MutationCtx,
  args: {
    userId: string;
    reason: ReleaseReason;
    stripeCheckoutSessionId?: string;
    bundleReservationId?: string;
  },
): Promise<boolean> {
  const reservation = args.stripeCheckoutSessionId
    ? await findBundleReservation(ctx, {
        stripeCheckoutSessionId: args.stripeCheckoutSessionId,
        bundleReservationId: args.bundleReservationId,
      })
    : args.bundleReservationId
      ? await (async () => {
          const id = ctx.db.normalizeId(
            "extra_usage_bundle_reservations",
            args.bundleReservationId!,
          );
          return id ? await ctx.db.get(id) : null;
        })()
      : null;

  if (reservation) {
    if (
      reservation.user_id !== args.userId ||
      reservation.status !== "reserved"
    )
      return false;
    if (args.stripeCheckoutSessionId) {
      if (
        reservation.stripe_checkout_session_id &&
        reservation.stripe_checkout_session_id !== args.stripeCheckoutSessionId
      )
        return false;
    } else if (
      args.reason !== "stripe_create_rejected" ||
      reservation.stripe_checkout_session_id ||
      reservation.create_attempts !== 1
    ) {
      return false;
    }
    await ctx.db.patch(reservation._id, {
      status: "released",
      release_reason: args.reason,
      ...(args.stripeCheckoutSessionId && {
        stripe_checkout_session_id: args.stripeCheckoutSessionId,
      }),
      updated_at: Date.now(),
    });
    convexLogger.info("extra_usage_bundle_reservation_released", {
      user_id: args.userId,
      reservation_id: reservation._id,
      period_month: reservation.period_month,
      policy_version: reservation.policy_version,
      credit_dollars: reservation.credit_dollars,
      reason: args.reason,
      stripe_checkout_session_id: args.stripeCheckoutSessionId,
    });
    return true;
  }

  if (!args.stripeCheckoutSessionId) return false;
  const ledger = await ctx.db
    .query("extra_usage_purchases")
    .withIndex("by_stripe_checkout_session_id", (q) =>
      q.eq("stripe_checkout_session_id", args.stripeCheckoutSessionId!),
    )
    .unique();
  if (
    !ledger?.bundle_id ||
    ledger.user_id !== args.userId ||
    ledger.status !== "created"
  )
    return false;
  await ctx.db.patch(ledger._id, {
    status: "failed",
    last_result: "failed",
    last_route: "repair",
    last_error: args.reason,
    updated_at: Date.now(),
  });
  convexLogger.info("extra_usage_bundle_legacy_session_released", {
    user_id: args.userId,
    reason: args.reason,
    stripe_checkout_session_id: args.stripeCheckoutSessionId,
  });
  return true;
}

export const releaseBundleHold = internalMutation({
  args: {
    userId: v.string(),
    reason: v.union(
      v.literal("stripe_session_expired"),
      v.literal("stripe_async_payment_failed"),
      v.literal("stripe_payment_canceled"),
      v.literal("stripe_create_rejected"),
    ),
    stripeCheckoutSessionId: v.optional(v.string()),
    bundleReservationId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => await releaseBundleHoldInternal(ctx, args),
});

/** Webhook entry point for Stripe-confirmed unpaid Checkout outcomes. */
export const releaseBundleSessionFromStripe = mutation({
  args: {
    serviceKey: v.string(),
    userId: v.string(),
    stripeCheckoutSessionId: v.string(),
    bundleReservationId: v.optional(v.string()),
    reason: v.union(
      v.literal("stripe_session_expired"),
      v.literal("stripe_async_payment_failed"),
    ),
  },
  returns: v.object({ released: v.boolean() }),
  handler: async (ctx, args) => {
    validateServiceKey(args.serviceKey);
    return {
      released: await releaseBundleHoldInternal(ctx, {
        userId: args.userId,
        reason: args.reason,
        stripeCheckoutSessionId: args.stripeCheckoutSessionId,
        bundleReservationId: args.bundleReservationId,
      }),
    };
  },
});
