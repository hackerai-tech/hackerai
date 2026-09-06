"use server";

import type Stripe from "stripe";

import { stripe } from "../../app/api/stripe";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { evaluateRetentionOffersForUser } from "@/lib/billing/retention-offer-evaluation";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";
import type { PauseSubscriptionResult } from "@/lib/billing/api-types";
import {
  parseCancellationReasonInput,
  stripeCancellationFeedback,
  type CancellationReasonInputLike,
} from "@/lib/billing/cancellation-reason-input";
import {
  computePauseResumeAt,
  isPauseDurationMonths,
  subscriptionPauseFromMetadata,
  subscriptionPauseMetadata,
} from "@/lib/billing/retention-offers";
import { releaseSubscriptionSchedule } from "@/lib/billing/subscription-schedule";
import { getConvexClient } from "@/lib/db/convex-client";
import { proMonthlyPricingExperimentProperties } from "@/lib/experiments/pro-monthly-pricing";
import { phLogger } from "@/lib/posthog/server";

type PauseSubscriptionInput = {
  months?: unknown;
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

export default async function pauseSubscriptionAction(
  input: PauseSubscriptionInput,
): Promise<PauseSubscriptionResult> {
  if (!isPauseDurationMonths(input.months)) {
    throw new Error(BILLING_ERRORS.invalidPauseDuration);
  }
  const months = input.months;
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

  const existingPause = subscriptionPauseFromMetadata(subscription.metadata);
  if (subscription.cancelAtPeriodEnd && existingPause) {
    return {
      paused: true,
      months: existingPause.months,
      pauseEffectiveAt:
        subscription.currentPeriodEndMs ?? existingPause.resumeAtMs,
      resumeAt: existingPause.resumeAtMs,
      alreadyScheduled: true,
    };
  }

  if (
    !evaluation.pause.eligible ||
    !subscription.currentPeriodEndMs ||
    !subscription.priceId
  ) {
    phLogger.warn("retention_pause_rejected", {
      ...billingFields,
      reason: evaluation.pause.eligible
        ? "missing_subscription_details"
        : evaluation.pause.reason,
    });
    throw new Error(BILLING_ERRORS.retentionOfferUnavailable);
  }

  const now = Date.now();
  const pauseEffectiveAt = subscription.currentPeriodEndMs;
  const resumeAt = computePauseResumeAt(pauseEffectiveAt, months);
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    phLogger.error("retention_pause_service_key_missing", billingFields);
    throw new Error(BILLING_ERRORS.retentionOfferUnavailable);
  }
  const convex = getConvexClient();

  const accountCreatedAt = parseCreatedAtMs(user);
  let cancellationReasonId: Id<"cancellation_reasons"> | undefined;
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

  const { pauseId } = await convex.mutation(
    api.subscriptionPauses.recordScheduledPause,
    {
      serviceKey,
      userId: user.id,
      organizationId,
      stripeCustomerId,
      stripeSubscriptionId: subscription.id,
      stripePriceId: subscription.priceId,
      stripePriceLookupKey: subscription.plan,
      subscriptionTier: subscription.tier,
      quantity: subscription.quantity,
      stripePaymentMethodId: subscription.defaultPaymentMethodId,
      reasonCategory: cancellationReason.reasonCategory,
      pauseMonths: months,
      requestedAt: now,
      pauseEffectiveAt,
      resumeAt,
    },
  );

  let updatedSubscription: Stripe.Subscription;
  try {
    // A pending retention downgrade would block the pause update.
    await releaseSubscriptionSchedule(subscription.scheduleId, {
      ...billingFields,
      reason: "pause",
    });
    updatedSubscription = await stripe.subscriptions.update(subscription.id, {
      cancel_at_period_end: true,
      cancellation_details: {
        feedback: stripeCancellationFeedback(cancellationReason.reasonCategory),
        comment: `Paused for ${months} month${months === 1 ? "" : "s"} via HackerAI retention offer`,
      },
      metadata: {
        ...subscription.metadata,
        ...subscriptionPauseMetadata({
          pauseId,
          months,
          resumeAtMs: resumeAt,
          requestedAtMs: now,
        }),
      },
    });
  } catch (error) {
    try {
      await convex.mutation(api.subscriptionPauses.cancelScheduledPause, {
        serviceKey,
        stripeSubscriptionId: subscription.id,
        canceledAt: Date.now(),
      });
    } catch (rollbackError) {
      phLogger.error("retention_pause_rollback_failed", {
        ...billingFields,
        pause_id: pauseId,
        error: rollbackError,
      });
    }
    phLogger.error("retention_pause_stripe_update_failed", {
      ...billingFields,
      pause_id: pauseId,
      error,
    });
    throw error;
  }

  if (cancellationReasonId) {
    try {
      await convex.mutation(
        api.cancellationReasons.recordRetentionOfferAccepted,
        {
          serviceKey,
          cancellationReasonId,
          retentionOffer: "pause",
          acceptedAt: now,
        },
      );
    } catch (error) {
      phLogger.warn("retention_offer_acceptance_record_failed", {
        ...billingFields,
        retention_offer: "pause",
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
    retention_offer: "pause",
    pause_months: months,
    pause_effective_at: new Date(pauseEffectiveAt).toISOString(),
    pause_resume_at: new Date(resumeAt).toISOString(),
    pause_id: pauseId,
    surface: "cancel_subscription_dialog",
    source: "account_settings",
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.priceId,
    cancel_at_period_end: updatedSubscription.cancel_at_period_end,
    ...proMonthlyPricingExperimentProperties(subscription.pricingExperiment),
  });

  phLogger.event(PAID_FUNNEL_EVENTS.retentionOfferAccepted, {
    ...offerProperties,
    $insert_id: `${PAID_FUNNEL_EVENTS.retentionOfferAccepted}:pause:${subscription.id}:${pauseId}`,
  });
  phLogger.event(PAID_FUNNEL_EVENTS.subscriptionPauseScheduled, {
    ...offerProperties,
    $insert_id: `${PAID_FUNNEL_EVENTS.subscriptionPauseScheduled}:${pauseId}`,
    $set: {
      last_subscription_pause_scheduled_at: new Date(now).toISOString(),
    },
  });

  return {
    paused: true,
    months,
    pauseEffectiveAt,
    resumeAt,
    alreadyScheduled: false,
  };
}
