"use server";

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
import { scheduleDowngradeAtPeriodEnd } from "@/lib/billing/subscription-schedule";
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
 * Accept the "switch to a cheaper plan" retention offer. The change is
 * scheduled for the end of the paid period through a Stripe Subscription
 * Schedule: the user keeps the current plan until then, the next renewal is
 * at the cheaper price, and no credit or proration is involved. The webhook
 * treats the phase transition like any other plan change.
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

  if (
    !downgrade.eligible ||
    !downgradeTarget ||
    !subscription.currentPeriodEndMs
  ) {
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

  const fromPlan = subscription.plan ?? subscription.tier ?? "unknown";
  let scheduled: Awaited<ReturnType<typeof scheduleDowngradeAtPeriodEnd>>;
  try {
    scheduled = await scheduleDowngradeAtPeriodEnd({
      subscription: subscription.subscription,
      targetPriceId: downgradeTarget.priceId,
      phaseMetadata: {
        ...subscription.metadata,
        checkoutType: "subscription_change",
        checkoutSource: RETENTION_DOWNGRADE_CHECKOUT_SOURCE,
        checkoutSurface: "cancel_subscription_dialog",
        checkoutReason: cancellationReason.reasonCategory,
        ...retentionDowngradeMetadata({ fromPlan, scheduledAtMs: now }),
      },
      scheduleMetadata: {
        purpose: "retention_downgrade",
        userId: user.id,
        fromPlan,
        toPlan: downgradeTarget.lookupKey,
        reasonCategory: cancellationReason.reasonCategory,
      },
    });
  } catch (error) {
    phLogger.error("retention_downgrade_schedule_failed", {
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
    currency: downgradeTarget.currency,
    effective_at: new Date(scheduled.effectiveAtMs).toISOString(),
    surface: "cancel_subscription_dialog",
    source: "account_settings",
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    stripe_subscription_schedule_id: scheduled.scheduleId,
    stripe_price_id: subscription.priceId,
    target_stripe_price_id: downgradeTarget.priceId,
    ...proMonthlyPricingExperimentProperties(subscription.pricingExperiment),
  });

  phLogger.event(PAID_FUNNEL_EVENTS.retentionOfferAccepted, {
    ...offerProperties,
    $insert_id: `${PAID_FUNNEL_EVENTS.retentionOfferAccepted}:downgrade:${scheduled.scheduleId}`,
  });
  phLogger.event(PAID_FUNNEL_EVENTS.retentionDowngradeScheduled, {
    ...offerProperties,
    $insert_id: `${PAID_FUNNEL_EVENTS.retentionDowngradeScheduled}:${scheduled.scheduleId}`,
    $set: {
      last_retention_downgrade_scheduled_at: new Date(now).toISOString(),
    },
  });

  return {
    scheduled: true,
    effectiveAt: scheduled.effectiveAtMs,
    fromTier: subscription.tier,
    toTier: downgrade.target.tier,
    toPlan: downgradeTarget.lookupKey,
    ...(downgradeTarget.unitAmountDollars !== undefined && {
      targetAmountDollars: downgradeTarget.unitAmountDollars,
    }),
    ...(downgradeTarget.currency && { currency: downgradeTarget.currency }),
  };
}
