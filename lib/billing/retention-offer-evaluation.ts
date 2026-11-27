import type Stripe from "stripe";

import { stripe } from "@/app/api/stripe";
import { api } from "@/convex/_generated/api";
import type {
  RetentionDowngradeRenewalCharge,
  RetentionOffers,
} from "@/lib/billing/api-types";
import type {
  CancellationReasonCategory,
  CancellationReasonSubcategory,
} from "@/lib/billing/cancellation-reasons";
import {
  getCurrentSubscriptionContext,
  type CurrentSubscriptionContext,
} from "@/lib/billing/current-subscription";
import {
  PAUSE_DURATION_MONTH_OPTIONS,
  computePauseResumeAt,
  evaluateDowngradeOfferEligibility,
  evaluatePauseOfferEligibility,
  type DowngradeOfferEligibility,
  type PauseOfferEligibility,
  type DowngradeReasonPolicy,
} from "@/lib/billing/retention-offers";
import {
  getDowngradeOfferPolicy,
  getPauseOfferFlagState,
  type RetentionOfferFlagState,
} from "@/lib/billing/retention-offers.server";
import { stripeObjectId } from "@/lib/billing/subscription-payment-failure";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

export type DowngradeTargetPrice = {
  priceId: string;
  lookupKey: string;
  unitAmountDollars?: number;
  currency?: string;
};

export type RetentionOfferEvaluation = {
  offersEnabled: boolean;
  flagState: RetentionOfferFlagState;
  downgradeFlagState: RetentionOfferFlagState;
  downgradeReasonPolicy: DowngradeReasonPolicy;
  pause: PauseOfferEligibility;
  downgrade: DowngradeOfferEligibility;
  downgradeTarget?: DowngradeTargetPrice;
  subscription: CurrentSubscriptionContext;
  lastPauseRequestedAtMs?: number;
};

async function lastPauseRequestedAt(
  userId: string,
): Promise<number | undefined> {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    phLogger.error("retention_offer_service_key_missing", { userId });
    // Fail closed for the pause offer: an unknown history counts as recent.
    return Date.now();
  }

  try {
    const pause = await getConvexClient().query(
      api.subscriptionPauses.getLatestPauseForUser,
      { serviceKey, userId },
    );
    return pause?.requestedAt;
  } catch (error) {
    phLogger.warn("retention_offer_pause_history_lookup_failed", {
      userId,
      error,
    });
    // Fail closed for the pause offer: an unknown history counts as recent.
    return Date.now();
  }
}

function priceAmountDollars(price: Stripe.Price): number | undefined {
  return typeof price.unit_amount === "number"
    ? price.unit_amount / 100
    : undefined;
}

/**
 * Resolve the Stripe price for the downgrade target. Fails closed for the
 * downgrade only, so a Stripe error cannot hide the pause offer.
 */
export async function resolveDowngradeTargetPrice(args: {
  lookupKey: string;
}): Promise<DowngradeTargetPrice | undefined> {
  let price: Stripe.Price | undefined;
  try {
    const prices = await stripe.prices.list({
      lookup_keys: [args.lookupKey],
      active: true,
      limit: 1,
    });
    price = prices.data[0];
  } catch (error) {
    phLogger.warn("retention_downgrade_target_price_lookup_failed", {
      lookup_key: args.lookupKey,
      error,
    });
    return undefined;
  }
  if (!price) {
    phLogger.error("retention_downgrade_target_price_missing", {
      lookup_key: args.lookupKey,
    });
    return undefined;
  }

  return {
    priceId: price.id,
    lookupKey: args.lookupKey,
    unitAmountDollars: priceAmountDollars(price),
    currency: price.currency,
  };
}

/** Shared server-side eligibility check for previewing and accepting offers. */
export async function evaluateRetentionOffersForUser(args: {
  userId: string;
  stripeCustomerId: string;
  reasonCategory: CancellationReasonCategory;
  reasonSubcategory?: CancellationReasonSubcategory;
  subscription?: CurrentSubscriptionContext;
}): Promise<RetentionOfferEvaluation> {
  const subscription =
    args.subscription ??
    (await getCurrentSubscriptionContext(args.stripeCustomerId));
  const downgradePolicy = getDowngradeOfferPolicy();
  const flagState = await getPauseOfferFlagState(args.userId);
  const offersEnabled = flagState === "enabled";
  const lastPauseRequestedAtMs = offersEnabled
    ? await lastPauseRequestedAt(args.userId)
    : undefined;

  const shared = {
    tier: subscription.tier,
    billingInterval: subscription.billingInterval,
    billingIntervalCount: subscription.billingIntervalCount,
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    quantity: subscription.quantity,
    reasonCategory: args.reasonCategory,
  };

  const pause = evaluatePauseOfferEligibility({
    ...shared,
    offersEnabled,
    currentPeriodEndMs: subscription.currentPeriodEndMs,
    lastPauseRequestedAtMs,
  });

  const downgrade = evaluateDowngradeOfferEligibility({
    ...shared,
    reasonSubcategory: args.reasonSubcategory,
    offersEnabled: downgradePolicy.state === "enabled",
    reasonPolicy: downgradePolicy.reasonPolicy,
    downgradeAlreadyScheduled: Boolean(subscription.scheduleId),
    currentPeriodEndMs: subscription.currentPeriodEndMs,
  });

  const downgradeTarget = downgrade.eligible
    ? await resolveDowngradeTargetPrice({
        lookupKey: downgrade.target.lookupKey,
      })
    : undefined;

  return {
    offersEnabled,
    flagState,
    downgradeFlagState: downgradePolicy.state,
    downgradeReasonPolicy: downgradePolicy.reasonPolicy,
    pause,
    downgrade:
      downgrade.eligible && !downgradeTarget
        ? { eligible: false, reason: "no_downgrade_target" }
        : downgrade,
    downgradeTarget,
    subscription,
    lastPauseRequestedAtMs,
  };
}

export type DowngradeRenewalPreview =
  | { status: "verified"; charge: RetentionDowngradeRenewalCharge }
  | { status: "unavailable"; reason: string };

function invoiceLinePriceId(line: Stripe.InvoiceLineItem): string | undefined {
  return stripeObjectId(line.pricing?.price_details?.price) ?? undefined;
}

/** Why a preview cannot be tied to the scheduled renewal, if it cannot. */
function renewalPreviewMismatch(
  preview: Stripe.Invoice,
  expected: { target: DowngradeTargetPrice; periodEndSeconds: number },
): string | undefined {
  if (
    !expected.target.currency ||
    preview.currency !== expected.target.currency
  ) {
    return "currency_mismatch";
  }
  if (preview.lines?.has_more) return "incomplete_lines";
  if (
    preview.automatic_tax?.enabled &&
    preview.automatic_tax.status !== "complete"
  ) {
    return "tax_incomplete";
  }

  const lines = preview.lines?.data ?? [];
  if (
    lines.some(
      (line) =>
        line.parent?.subscription_item_details?.proration === true ||
        line.parent?.invoice_item_details?.proration === true,
    )
  ) {
    return "unexpected_proration";
  }

  const subscriptionLines = lines.filter(
    (line) => line.parent?.type === "subscription_item_details",
  );
  const targetLine = subscriptionLines[0];
  if (
    subscriptionLines.length !== 1 ||
    !targetLine ||
    invoiceLinePriceId(targetLine) !== expected.target.priceId ||
    targetLine.quantity !== 1
  ) {
    return "target_line_mismatch";
  }
  if (
    targetLine.period?.start !== expected.periodEndSeconds ||
    !(targetLine.period.end > targetLine.period.start)
  ) {
    return "cycle_date_mismatch";
  }
  if (!Number.isInteger(preview.amount_due) || preview.amount_due < 0) {
    return "invalid_amount";
  }
  return undefined;
}

/**
 * Read-only Stripe preview of the first invoice on the cheaper plan. It
 * mirrors the scheduled phase: same subscription item, target price, one
 * seat and no proration at the paid-through date. The result is used only
 * when every check ties it to that exact renewal; otherwise the offer falls
 * back to the regular monthly rate.
 */
export async function previewDowngradeRenewalCharge(args: {
  stripeCustomerId: string;
  subscription: CurrentSubscriptionContext;
  target: DowngradeTargetPrice;
}): Promise<DowngradeRenewalPreview> {
  const { subscription, target } = args;
  const periodEndMs = subscription.currentPeriodEndMs;
  const items = subscription.subscription.items?.data ?? [];
  if (!subscription.itemId || !periodEndMs || items.length !== 1) {
    return { status: "unavailable", reason: "unsupported_subscription_shape" };
  }
  // The scheduled phase does not carry subscription- or item-level discounts
  // forward (only the customer's), so a preview of the live subscription
  // would understate the charge.
  if (
    (subscription.subscription.discounts?.length ?? 0) > 0 ||
    (items[0]?.discounts?.length ?? 0) > 0
  ) {
    return { status: "unavailable", reason: "subscription_discount" };
  }

  let preview: Stripe.Invoice;
  try {
    preview = await stripe.invoices.createPreview(
      {
        customer: args.stripeCustomerId,
        subscription: subscription.id,
        subscription_details: {
          items: [
            { id: subscription.itemId, price: target.priceId, quantity: 1 },
          ],
          proration_behavior: "none",
        },
      },
      // A slow estimate must not keep the customer waiting to cancel.
      { timeout: 4_000, maxNetworkRetries: 0 },
    );
  } catch (error) {
    phLogger.warn("retention_downgrade_renewal_preview_failed", {
      stripe_subscription_id: subscription.id,
      target_stripe_price_id: target.priceId,
      error,
    });
    return { status: "unavailable", reason: "preview_failed" };
  }

  const reason = renewalPreviewMismatch(preview, {
    target,
    periodEndSeconds: Math.floor(periodEndMs / 1000),
  });
  if (reason) {
    phLogger.warn("retention_downgrade_renewal_preview_rejected", {
      stripe_subscription_id: subscription.id,
      target_stripe_price_id: target.priceId,
      reason,
    });
    return { status: "unavailable", reason };
  }

  return {
    status: "verified",
    charge: {
      amountDollars: preview.amount_due / 100,
      currency: preview.currency,
      chargeAt: periodEndMs,
    },
  };
}

export function buildRetentionOffers(
  evaluation: RetentionOfferEvaluation,
  renewalPreview?: DowngradeRenewalPreview,
): RetentionOffers {
  const { pause, downgrade, downgradeTarget, subscription } = evaluation;
  const periodEndMs = subscription.currentPeriodEndMs;
  const pauseOptions =
    pause.eligible && periodEndMs
      ? PAUSE_DURATION_MONTH_OPTIONS.map((months) => ({
          months,
          resumeAt: computePauseResumeAt(periodEndMs, months),
        }))
      : [];
  const currentAmountDollars =
    subscription.unitAmountDollars === undefined
      ? undefined
      : subscription.unitAmountDollars * subscription.quantity;

  return {
    offersEnabled: evaluation.offersEnabled,
    subscriptionTier: subscription.tier,
    plan: subscription.plan,
    pause: {
      eligible: pause.eligible,
      ...(!pause.eligible && { reason: pause.reason }),
      ...(periodEndMs && { pauseEffectiveAt: periodEndMs }),
      options: pauseOptions,
    },
    downgrade:
      downgrade.eligible && downgradeTarget
        ? {
            eligible: true,
            targetTier: downgrade.target.tier,
            targetPlan: downgradeTarget.lookupKey,
            ...(downgradeTarget.unitAmountDollars !== undefined && {
              targetAmountDollars: downgradeTarget.unitAmountDollars,
            }),
            ...(currentAmountDollars !== undefined && { currentAmountDollars }),
            ...(downgradeTarget.currency && {
              currency: downgradeTarget.currency,
            }),
            ...(periodEndMs && { effectiveAt: periodEndMs }),
            ...(renewalPreview?.status === "verified" && {
              renewalCharge: renewalPreview.charge,
            }),
          }
        : {
            eligible: false,
            reason: downgrade.eligible
              ? "no_downgrade_target"
              : downgrade.reason,
          },
  };
}

/** Privacy-safe analytics properties describing an offer evaluation. */
export function retentionOfferEvaluationProperties(
  evaluation: RetentionOfferEvaluation,
  reasonCategory: CancellationReasonCategory,
  reasonSubcategory?: CancellationReasonSubcategory,
) {
  const { pause, downgrade, downgradeTarget, subscription } = evaluation;
  return {
    subscription_tier: subscription.tier,
    plan: subscription.plan,
    stripe_price_lookup_key: subscription.plan,
    billing_interval: subscription.billingInterval,
    subscription_status: subscription.status,
    reason_category: reasonCategory,
    reason_subcategory: reasonSubcategory,
    pause_offer_flag_state: evaluation.flagState,
    pause_offered: pause.eligible,
    pause_ineligibility_reason: pause.eligible ? undefined : pause.reason,
    downgrade_offer_flag_state: evaluation.downgradeFlagState,
    downgrade_offer_variant: evaluation.downgradeReasonPolicy,
    downgrade_offered: downgrade.eligible && Boolean(downgradeTarget),
    downgrade_ineligibility_reason: downgrade.eligible
      ? downgradeTarget
        ? undefined
        : "no_downgrade_target"
      : downgrade.reason,
    downgrade_target_plan: downgradeTarget?.lookupKey,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.priceId,
  };
}
