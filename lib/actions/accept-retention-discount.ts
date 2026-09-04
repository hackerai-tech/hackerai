"use server";

import { stripe } from "../../app/api/stripe";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { evaluateRetentionOffersForUser } from "@/lib/actions/retention-offers";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";
import type { AcceptRetentionDiscountResult } from "@/lib/billing/api-types";
import {
  parseCancellationReasonInput,
  type CancellationReasonInputLike,
} from "@/lib/billing/cancellation-reason-input";
import { ensureRetentionCoupon } from "@/lib/billing/retention-coupon";
import {
  RETENTION_DISCOUNT,
  discountedAmountDollars,
  retentionDiscountMetadata,
} from "@/lib/billing/retention-offers";
import { getConvexClient } from "@/lib/db/convex-client";
import { proMonthlyPricingExperimentProperties } from "@/lib/experiments/pro-monthly-pricing";
import { phLogger } from "@/lib/posthog/server";

type AcceptRetentionDiscountInput = {
  cancellationReason?: CancellationReasonInputLike;
};

function parseCreatedAtMs(value: unknown): number | undefined {
  const raw = (value as { createdAt?: unknown; created_at?: unknown }) ?? {};
  const createdAt = raw.createdAt ?? raw.created_at;
  if (createdAt instanceof Date) return createdAt.getTime();
  if (typeof createdAt === "string" || typeof createdAt === "number") {
    const timestamp = new Date(createdAt).getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  return undefined;
}

export default async function acceptRetentionDiscountAction(
  input: AcceptRetentionDiscountInput,
): Promise<AcceptRetentionDiscountResult> {
  const cancellationReason = parseCancellationReasonInput(
    input.cancellationReason,
  );
  const { organizationId, user, stripeCustomerId } =
    await getBillingActionContext();
  const evaluation = await evaluateRetentionOffersForUser({
    userId: user.id,
    stripeCustomerId,
    reasonCategory: cancellationReason.reasonCategory,
  });
  const { subscription } = evaluation;
  const billingFields = {
    userId: user.id,
    org_id: organizationId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
  };

  if (!evaluation.eligibility.discount.eligible) {
    phLogger.warn("retention_discount_rejected", {
      ...billingFields,
      reason: evaluation.eligibility.discount.reason,
    });
    throw new Error(BILLING_ERRORS.retentionOfferUnavailable);
  }

  const now = Date.now();
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  const convex = getConvexClient();
  const accountCreatedAt = parseCreatedAtMs(user);

  let cancellationReasonId: Id<"cancellation_reasons"> | undefined;
  if (serviceKey) {
    try {
      cancellationReasonId = await convex.mutation(
        api.cancellationReasons.recordCancellationStarted,
        {
          serviceKey,
          userId: user.id,
          organizationId,
          stripeCustomerId,
          stripeSubscriptionId: subscription.id,
          stripePriceId: subscription.priceId,
          plan: subscription.plan,
          subscriptionTier: subscription.tier,
          reasonCategory: cancellationReason.reasonCategory,
          reasonSubcategory: cancellationReason.reasonSubcategory,
          reasonDetails: cancellationReason.reasonDetails,
          accountCreatedAt,
          accountAgeDays: accountCreatedAt
            ? Math.max(0, Math.floor((now - accountCreatedAt) / 86_400_000))
            : undefined,
          startedAt: now,
          source: "in_app",
        },
      );
    } catch (error) {
      phLogger.error("Failed to record cancellation reason", {
        ...billingFields,
        error,
      });
    }
  } else {
    phLogger.error("Failed to record cancellation reason", {
      ...billingFields,
      error: new Error("CONVEX_SERVICE_ROLE_KEY is not set"),
    });
  }

  let couponId: string;
  try {
    couponId = await ensureRetentionCoupon();
  } catch (error) {
    phLogger.error("retention_discount_coupon_unavailable", {
      ...billingFields,
      error,
    });
    throw error;
  }

  try {
    await stripe.subscriptions.update(subscription.id, {
      discounts: [{ coupon: couponId }],
      metadata: {
        ...subscription.metadata,
        ...retentionDiscountMetadata({ couponId, appliedAtMs: now }),
      },
    });
  } catch (error) {
    phLogger.error("retention_discount_stripe_update_failed", {
      ...billingFields,
      coupon_id: couponId,
      error,
    });
    throw error;
  }

  if (serviceKey && cancellationReasonId) {
    try {
      await convex.mutation(
        api.cancellationReasons.recordRetentionOfferAccepted,
        {
          serviceKey,
          cancellationReasonId,
          retentionOffer: "discount",
          acceptedAt: now,
        },
      );
    } catch (error) {
      phLogger.warn("retention_offer_acceptance_record_failed", {
        ...billingFields,
        retention_offer: "discount",
        error,
      });
    }
  }

  const currentAmountDollars =
    subscription.unitAmountDollars === undefined
      ? undefined
      : subscription.unitAmountDollars * subscription.quantity;
  const discountedAmount =
    currentAmountDollars === undefined
      ? undefined
      : discountedAmountDollars(
          currentAmountDollars,
          RETENTION_DISCOUNT.percentOff,
        );

  phLogger.event(
    PAID_FUNNEL_EVENTS.retentionOfferAccepted,
    paidFunnelProperties({
      userId: user.id,
      org_id: organizationId,
      subscription_tier: subscription.tier,
      plan: subscription.plan,
      stripe_price_lookup_key: subscription.plan,
      billing_interval: subscription.billingInterval,
      reason_category: cancellationReason.reasonCategory,
      reason_subcategory: cancellationReason.reasonSubcategory,
      retention_offer: "discount",
      discount_percent_off: RETENTION_DISCOUNT.percentOff,
      discount_duration_months: RETENTION_DISCOUNT.durationMonths,
      discount_coupon_id: couponId,
      current_amount_dollars: currentAmountDollars,
      discounted_amount_dollars: discountedAmount,
      currency: subscription.currency,
      surface: "cancel_subscription_dialog",
      source: "account_settings",
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: subscription.id,
      stripe_price_id: subscription.priceId,
      ...proMonthlyPricingExperimentProperties(subscription.pricingExperiment),
      $insert_id: `${PAID_FUNNEL_EVENTS.retentionOfferAccepted}:discount:${subscription.id}`,
      $set: {
        last_retention_discount_accepted_at: new Date(now).toISOString(),
      },
    }),
  );

  return {
    applied: true,
    percentOff: RETENTION_DISCOUNT.percentOff,
    durationMonths: RETENTION_DISCOUNT.durationMonths,
    ...(currentAmountDollars !== undefined && { currentAmountDollars }),
    ...(discountedAmount !== undefined && {
      discountedAmountDollars: discountedAmount,
    }),
    ...(subscription.currency && { currency: subscription.currency }),
    ...(subscription.currentPeriodEndMs && {
      nextRenewalAt: subscription.currentPeriodEndMs,
    }),
  };
}
