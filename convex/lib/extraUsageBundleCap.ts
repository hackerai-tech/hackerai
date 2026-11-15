import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./serviceFunctions";
import {
  EXTRA_USAGE_BUNDLES,
  EXTRA_USAGE_BUNDLE_CAP,
  extraUsageBundleCapPeriod,
} from "../../lib/billing/extra-usage-bundles";
import { convexLogger } from "./logger";

/**
 * Per-status read bound. The cap admits at most 40 live holds per month, so
 * reaching this bound means unexpected history; callers then fail closed.
 */
export const BUNDLE_CAP_READ_LIMIT = 100;

/**
 * Stripe may forget an idempotency key after 24 hours; replaying it later could
 * create a second payable session. Unlinked holds older than this, measured
 * from the reservation's original creation, are only searched for, never
 * re-created.
 */
export const BUNDLE_IDEMPOTENCY_REPLAY_WINDOW_MS = 23 * 60 * 60_000;

/** Ledger markers proving a legacy (pre-reservation) session never paid. */
export const UNPAID_LEGACY_BUNDLE_ERRORS = new Set([
  "stripe_async_payment_failed",
  "stripe_session_expired",
]);

type Reservation = Doc<"extra_usage_bundle_reservations">;

export type PendingBundleHold =
  | {
      kind: "reservation";
      reservationId: Id<"extra_usage_bundle_reservations">;
      bundleId: string;
      stripeCheckoutSessionId?: string;
      stripeCustomerId: string;
      createdAt: number;
    }
  | { kind: "legacy"; bundleId: string; stripeCheckoutSessionId: string };

export type BundleCapUsage =
  | {
      complete: true;
      policyVersion: string;
      periodMonth: string;
      resetsAt: number;
      capDollars: number;
      usedDollars: number;
      pendingDollars: number;
      remainingDollars: number;
      pendingHolds: PendingBundleHold[];
    }
  | {
      complete: false;
      policyVersion: string;
      periodMonth: string;
      resetsAt: number;
      capDollars: number;
      reason: "reservation_history_incomplete" | "ledger_history_incomplete";
    };

/**
 * Discounted face value held or consumed in the UTC month containing `now`.
 *
 * Reservations are authoritative. Ledger rows from before the cap existed are
 * counted only when no reservation claims their Checkout session, so a
 * reserved purchase is never counted twice. Full-price top-ups have no
 * bundle_id and never enter these index ranges.
 */
export async function readBundleCapUsage(
  ctx: QueryCtx | MutationCtx,
  userId: string,
  now: number,
): Promise<BundleCapUsage> {
  const { periodMonth, periodStart, resetsAt } = extraUsageBundleCapPeriod(now);
  const base = {
    policyVersion: EXTRA_USAGE_BUNDLE_CAP.policyVersion,
    periodMonth,
    resetsAt,
    capDollars: EXTRA_USAGE_BUNDLE_CAP.creditDollars,
  };

  let usedDollars = 0;
  let pendingDollars = 0;
  const pendingHolds: PendingBundleHold[] = [];

  for (const status of ["reserved", "consumed"] as const) {
    const rows: Reservation[] = await ctx.db
      .query("extra_usage_bundle_reservations")
      .withIndex("by_user_period_status_bundle", (q) =>
        q
          .eq("user_id", userId)
          .eq("period_month", periodMonth)
          .eq("status", status),
      )
      .take(BUNDLE_CAP_READ_LIMIT);
    if (rows.length >= BUNDLE_CAP_READ_LIMIT) {
      return {
        ...base,
        complete: false,
        reason: "reservation_history_incomplete",
      };
    }
    for (const row of rows) {
      if (status === "consumed") {
        usedDollars += row.credit_dollars;
        continue;
      }
      pendingDollars += row.credit_dollars;
      pendingHolds.push({
        kind: "reservation",
        reservationId: row._id,
        bundleId: row.bundle_id,
        stripeCheckoutSessionId: row.stripe_checkout_session_id,
        stripeCustomerId: row.stripe_customer_id,
        createdAt: row.created_at,
      });
    }
  }

  for (const offer of EXTRA_USAGE_BUNDLES) {
    const rows = await ctx.db
      .query("extra_usage_purchases")
      .withIndex("by_user_bundle_created_at", (q) =>
        q
          .eq("user_id", userId)
          .eq("bundle_id", offer.id)
          .gte("created_at", periodStart)
          .lt("created_at", resetsAt),
      )
      .take(BUNDLE_CAP_READ_LIMIT);
    if (rows.length >= BUNDLE_CAP_READ_LIMIT) {
      return { ...base, complete: false, reason: "ledger_history_incomplete" };
    }
    for (const row of rows) {
      const claimed = await ctx.db
        .query("extra_usage_bundle_reservations")
        .withIndex("by_stripe_checkout_session_id", (q) =>
          q.eq("stripe_checkout_session_id", row.stripe_checkout_session_id),
        )
        .first();
      if (claimed) continue;
      if (row.status === "created") {
        // A pre-cap session may still be paid; hold it until Stripe confirms.
        pendingDollars += row.amount_dollars;
        pendingHolds.push({
          kind: "legacy",
          bundleId: offer.id,
          stripeCheckoutSessionId: row.stripe_checkout_session_id,
        });
      } else if (
        row.status === "failed" &&
        row.last_error &&
        UNPAID_LEGACY_BUNDLE_ERRORS.has(row.last_error)
      ) {
        continue;
      } else {
        // paid_seen, credited, and post-payment credit failures all consume.
        usedDollars += row.amount_dollars;
      }
    }
  }

  return {
    ...base,
    complete: true,
    usedDollars,
    pendingDollars,
    remainingDollars: Math.max(
      0,
      EXTRA_USAGE_BUNDLE_CAP.creditDollars - usedDollars - pendingDollars,
    ),
    pendingHolds,
  };
}

/** Find the reservation behind a Checkout session, by link or by metadata. */
export async function findBundleReservation(
  ctx: QueryCtx | MutationCtx,
  args: { stripeCheckoutSessionId: string; bundleReservationId?: string },
): Promise<Reservation | null> {
  const linked = await ctx.db
    .query("extra_usage_bundle_reservations")
    .withIndex("by_stripe_checkout_session_id", (q) =>
      q.eq("stripe_checkout_session_id", args.stripeCheckoutSessionId),
    )
    .first();
  if (linked) return linked;
  if (!args.bundleReservationId) return null;
  const id = ctx.db.normalizeId(
    "extra_usage_bundle_reservations",
    args.bundleReservationId,
  );
  return id ? await ctx.db.get(id) : null;
}

/**
 * Consume the reservation for a paid bundle session. Never blocks fulfillment:
 * a paid session is consumed even if it was released, and that rare overrun is
 * logged for reconciliation instead of withholding paid credit.
 */
export async function consumeBundleReservation(
  ctx: MutationCtx,
  args: {
    userId: string;
    bundleId: string;
    stripeCheckoutSessionId: string;
    bundleReservationId?: string;
  },
): Promise<void> {
  const reservation = await findBundleReservation(ctx, args);
  if (!reservation) return;
  if (
    reservation.user_id !== args.userId ||
    reservation.bundle_id !== args.bundleId ||
    (reservation.stripe_checkout_session_id !== undefined &&
      reservation.stripe_checkout_session_id !== args.stripeCheckoutSessionId)
  ) {
    convexLogger.error("extra_usage_bundle_reservation_mismatch", {
      user_id: args.userId,
      reservation_id: reservation._id,
      stripe_checkout_session_id: args.stripeCheckoutSessionId,
    });
    return;
  }
  if (reservation.status === "consumed") return;
  const consumedAfterRelease = reservation.status === "released";
  await ctx.db.patch(reservation._id, {
    status: "consumed",
    stripe_checkout_session_id: args.stripeCheckoutSessionId,
    ...(consumedAfterRelease && { consumed_after_release: true }),
    updated_at: Date.now(),
  });
  if (consumedAfterRelease) {
    convexLogger.warn("extra_usage_bundle_paid_after_release", {
      user_id: args.userId,
      reservation_id: reservation._id,
      period_month: reservation.period_month,
      stripe_checkout_session_id: args.stripeCheckoutSessionId,
      release_reason: reservation.release_reason,
    });
  }
}
