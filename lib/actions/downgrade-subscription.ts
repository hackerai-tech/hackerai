"use server";

import type Stripe from "stripe";

import { stripe } from "../../app/api/stripe";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import type { DowngradeSubscriptionResult } from "@/lib/billing/api-types";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";
import {
  parseCancellationReasonInput,
  type CancellationReasonInputLike,
} from "@/lib/billing/cancellation-reason-input";
import { evaluateRetentionOffersForUser } from "@/lib/billing/retention-offer-evaluation";
import {
  RETENTION_DOWNGRADE_CHECKOUT_SOURCE,
  retentionDowngradeMetadata,
} from "@/lib/billing/retention-offers";
import { getConvexClient } from "@/lib/db/convex-client";
import { proMonthlyPricingExperimentProperties } from "@/lib/experiments/pro-monthly-pricing";
import { phLogger } from "@/lib/posthog/server";

type DowngradeSubscriptionInput = {
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

/**
 * Accept the "switch to a cheaper plan" retention offer. The change applies
 * immediately with Stripe proration, so the unused part of the current period
 * becomes account credit and the webhook migrates usage buckets the same way
 * it does for any plan change.
 */
export default async function downgradeSubscriptionAction(
  input: DowngradeSubscriptionInput,
): Promise<DowngradeSubscriptionResult> {
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
  const { subscription, downgrade, downgradeTarget } = evaluation;
  const billingFields = {
    userId: user.id,
    org_id: organizationId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
  };

  if (!downgrade.eligible || !downgradeTarget || !subscription.itemId) {
    phLogger.warn("retention_downgrade_rejected", {
      ...billingFields,
      reason: downgrade.eligible
        ? "missing_subscription_details"
        : downgrade.reason,
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

  let updatedSubscription: Stripe.Subscription;
  try {
    updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      items: [
        {
          id: subscription.itemId,
          price: downgradeTarget.priceId,
          quantity: 1,
        },
      ],
      proration_behavior: "always_invoice",
      proration_date: Math.floor(now / 1000),
      payment_behavior: "pending_if_incomplete",
      metadata: {
        ...subscription.metadata,
        checkoutType: "subscription_change",
        checkoutSource: RETENTION_DOWNGRADE_CHECKOUT_SOURCE,
        checkoutSurface: "cancel_subscription_dialog",
        checkoutReason: cancellationReason.reasonCategory,
        ...retentionDowngradeMetadata({
          fromPlan: subscription.plan ?? subscription.tier ?? "unknown",
          appliedAtMs: now,
        }),
      },
    });
  } catch (error) {
    phLogger.error("retention_downgrade_stripe_update_failed", {
      ...billingFields,
      target_price_id: downgradeTarget.priceId,
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
          retentionOffer: "downgrade",
          acceptedAt: now,
        },
      );
    } catch (error) {
      phLogger.warn("retention_offer_acceptance_record_failed", {
        ...billingFields,
        retention_offer: "downgrade",
        error,
      });
    }
  }

  const offerProperties = paidFunnelProperties({
    userId: user.id,
    org_id: organizationId,
    subscription_tier: subscription.tier,
    plan: subscription.plan,
    stripe_price_lookup_key: subscription.plan,
    billing_interval: subscription.billingInterval,
    reason_category: cancellationReason.reasonCategory,
    reason_subcategory: cancellationReason.reasonSubcategory,
    retention_offer: "downgrade",
    from_tier: subscription.tier,
    to_tier: downgrade.target.tier,
    to_plan: downgradeTarget.lookupKey,
    current_amount_dollars:
      subscription.unitAmountDollars === undefined
        ? undefined
        : subscription.unitAmountDollars * subscription.quantity,
    target_amount_dollars: downgradeTarget.unitAmountDollars,
    prorated_credit_dollars: downgradeTarget.proratedCreditDollars,
    currency: downgradeTarget.currency,
    surface: "cancel_subscription_dialog",
    source: "account_settings",
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.priceId,
    target_stripe_price_id: downgradeTarget.priceId,
    ...proMonthlyPricingExperimentProperties(subscription.pricingExperiment),
  });

  phLogger.event(PAID_FUNNEL_EVENTS.retentionOfferAccepted, {
    ...offerProperties,
    $insert_id: `${PAID_FUNNEL_EVENTS.retentionOfferAccepted}:downgrade:${subscription.id}`,
  });
  phLogger.event(PAID_FUNNEL_EVENTS.retentionDowngradeApplied, {
    ...offerProperties,
    subscription_status: updatedSubscription.status,
    $insert_id: `${PAID_FUNNEL_EVENTS.retentionDowngradeApplied}:${subscription.id}`,
    $set: {
      subscription_tier: downgrade.target.tier,
      last_retention_downgrade_at: new Date(now).toISOString(),
    },
  });

  return {
    downgraded: true,
    fromTier: subscription.tier,
    toTier: downgrade.target.tier,
    toPlan: downgradeTarget.lookupKey,
    ...(downgradeTarget.unitAmountDollars !== undefined && {
      targetAmountDollars: downgradeTarget.unitAmountDollars,
    }),
    ...(downgradeTarget.proratedCreditDollars !== undefined && {
      proratedCreditDollars: downgradeTarget.proratedCreditDollars,
    }),
    ...(downgradeTarget.currency && { currency: downgradeTarget.currency }),
  };
}
