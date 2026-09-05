import { api } from "@/convex/_generated/api";
import type { RetentionOffers } from "@/lib/billing/api-types";
import type { CancellationReasonCategory } from "@/lib/billing/cancellation-reasons";
import {
  getCurrentSubscriptionContext,
  type CurrentSubscriptionContext,
} from "@/lib/billing/current-subscription";
import {
  PAUSE_DURATION_MONTH_OPTIONS,
  computePauseResumeAt,
  evaluatePauseOfferEligibility,
  type PauseOfferEligibility,
} from "@/lib/billing/retention-offers";
import {
  getPauseOfferFlagState,
  type PauseOfferFlagState,
} from "@/lib/billing/retention-offers.server";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

export type RetentionOfferEvaluation = {
  offersEnabled: boolean;
  flagState: PauseOfferFlagState;
  pause: PauseOfferEligibility;
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

/** Shared server-side eligibility check for previewing and accepting the offer. */
export async function evaluateRetentionOffersForUser(args: {
  userId: string;
  stripeCustomerId: string;
  reasonCategory: CancellationReasonCategory;
  subscription?: CurrentSubscriptionContext;
}): Promise<RetentionOfferEvaluation> {
  const subscription =
    args.subscription ??
    (await getCurrentSubscriptionContext(args.stripeCustomerId));
  const flagState = await getPauseOfferFlagState(args.userId);
  const offersEnabled = flagState === "enabled";
  const lastPauseRequestedAtMs = offersEnabled
    ? await lastPauseRequestedAt(args.userId)
    : undefined;

  const pause = evaluatePauseOfferEligibility({
    offersEnabled,
    tier: subscription.tier,
    billingInterval: subscription.billingInterval,
    billingIntervalCount: subscription.billingIntervalCount,
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    quantity: subscription.quantity,
    reasonCategory: args.reasonCategory,
    currentPeriodEndMs: subscription.currentPeriodEndMs,
    lastPauseRequestedAtMs,
  });

  return {
    offersEnabled,
    flagState,
    pause,
    subscription,
    lastPauseRequestedAtMs,
  };
}

/** Privacy-safe analytics properties describing an offer evaluation. */
export function retentionOfferEvaluationProperties(
  evaluation: RetentionOfferEvaluation,
  reasonCategory: CancellationReasonCategory,
) {
  const { pause, subscription } = evaluation;
  return {
    subscription_tier: subscription.tier,
    plan: subscription.plan,
    stripe_price_lookup_key: subscription.plan,
    billing_interval: subscription.billingInterval,
    subscription_status: subscription.status,
    reason_category: reasonCategory,
    pause_offer_flag_state: evaluation.flagState,
    pause_offered: pause.eligible,
    pause_ineligibility_reason: pause.eligible ? undefined : pause.reason,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.priceId,
  };
}

export function buildRetentionOffers(
  evaluation: RetentionOfferEvaluation,
): RetentionOffers {
  const { pause, subscription } = evaluation;
  const periodEndMs = subscription.currentPeriodEndMs;
  const pauseOptions =
    pause.eligible && periodEndMs
      ? PAUSE_DURATION_MONTH_OPTIONS.map((months) => ({
          months,
          resumeAt: computePauseResumeAt(periodEndMs, months),
        }))
      : [];

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
  };
}
