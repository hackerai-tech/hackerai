"use server";

import { api } from "@/convex/_generated/api";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import type { RetentionOffers } from "@/lib/billing/api-types";
import { CANCELLATION_REASON_INPUT_ERRORS } from "@/lib/billing/cancellation-reason-input";
import {
  isCancellationReasonCategory,
  type CancellationReasonCategory,
} from "@/lib/billing/cancellation-reasons";
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
import { isPauseOfferEnabledForUser } from "@/lib/billing/retention-offers.server";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

type GetRetentionOffersInput = {
  reasonCategory?: unknown;
};

export type RetentionOfferEvaluation = {
  offersEnabled: boolean;
  pause: PauseOfferEligibility;
  subscription: CurrentSubscriptionContext;
  lastPauseRequestedAtMs?: number;
};

async function lastPauseRequestedAt(
  userId: string,
): Promise<number | undefined> {
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!serviceKey) return undefined;

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
  const offersEnabled = await isPauseOfferEnabledForUser(args.userId);
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

  return { offersEnabled, pause, subscription, lastPauseRequestedAtMs };
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

export default async function getRetentionOffersAction(
  input: GetRetentionOffersInput,
): Promise<RetentionOffers> {
  if (!isCancellationReasonCategory(input.reasonCategory)) {
    throw new Error(CANCELLATION_REASON_INPUT_ERRORS.missingCategory);
  }

  const { user, stripeCustomerId } = await getBillingActionContext();
  const evaluation = await evaluateRetentionOffersForUser({
    userId: user.id,
    stripeCustomerId,
    reasonCategory: input.reasonCategory,
  });

  return buildRetentionOffers(evaluation);
}
