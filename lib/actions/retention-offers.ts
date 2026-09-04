"use server";

import { api } from "@/convex/_generated/api";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import type { RetentionOffers } from "@/lib/billing/api-types";
import { isCancellationReasonCategory } from "@/lib/billing/cancellation-reasons";
import { CANCELLATION_REASON_INPUT_ERRORS } from "@/lib/billing/cancellation-reason-input";
import {
  getCurrentSubscriptionContext,
  type CurrentSubscriptionContext,
} from "@/lib/billing/current-subscription";
import {
  PAUSE_DURATION_MONTH_OPTIONS,
  RETENTION_DISCOUNT,
  computePauseResumeAt,
  discountedAmountDollars,
  evaluateRetentionOfferEligibility,
  retentionDiscountFromMetadata,
  type RetentionOfferEligibility,
} from "@/lib/billing/retention-offers";
import { isRetentionOffersEnabledForUser } from "@/lib/billing/retention-offers.server";
import type { CancellationReasonCategory } from "@/lib/billing/cancellation-reasons";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

type GetRetentionOffersInput = {
  reasonCategory?: unknown;
};

export type RetentionOfferEvaluation = {
  offersEnabled: boolean;
  eligibility: RetentionOfferEligibility;
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

/** Shared server-side eligibility check for previewing and accepting offers. */
export async function evaluateRetentionOffersForUser(args: {
  userId: string;
  stripeCustomerId: string;
  reasonCategory: CancellationReasonCategory;
  subscription?: CurrentSubscriptionContext;
}): Promise<RetentionOfferEvaluation> {
  const subscription =
    args.subscription ??
    (await getCurrentSubscriptionContext(args.stripeCustomerId));
  const offersEnabled = await isRetentionOffersEnabledForUser(args.userId);
  const lastPauseRequestedAtMs = offersEnabled
    ? await lastPauseRequestedAt(args.userId)
    : undefined;

  const eligibility = evaluateRetentionOfferEligibility({
    offersEnabled,
    tier: subscription.tier,
    billingInterval: subscription.billingInterval,
    billingIntervalCount: subscription.billingIntervalCount,
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    quantity: subscription.quantity,
    reasonCategory: args.reasonCategory,
    currentPeriodEndMs: subscription.currentPeriodEndMs,
    hasExistingDiscount: subscription.hasDiscount,
    retentionDiscountAlreadyApplied:
      retentionDiscountFromMetadata(subscription.metadata) !== null,
    lastPauseRequestedAtMs,
  });

  return { offersEnabled, eligibility, subscription, lastPauseRequestedAtMs };
}

export function buildRetentionOffers(
  evaluation: RetentionOfferEvaluation,
): RetentionOffers {
  const { eligibility, subscription } = evaluation;
  const periodEndMs = subscription.currentPeriodEndMs;
  const pauseOptions =
    eligibility.pause.eligible && periodEndMs
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
      eligible: eligibility.pause.eligible,
      ...(!eligibility.pause.eligible && { reason: eligibility.pause.reason }),
      ...(periodEndMs && { pauseEffectiveAt: periodEndMs }),
      options: pauseOptions,
    },
    discount: {
      eligible: eligibility.discount.eligible,
      ...(!eligibility.discount.eligible && {
        reason: eligibility.discount.reason,
      }),
      percentOff: RETENTION_DISCOUNT.percentOff,
      durationMonths: RETENTION_DISCOUNT.durationMonths,
      ...(currentAmountDollars !== undefined && {
        currentAmountDollars,
        discountedAmountDollars: discountedAmountDollars(
          currentAmountDollars,
          RETENTION_DISCOUNT.percentOff,
        ),
      }),
      ...(subscription.currency && { currency: subscription.currency }),
      ...(periodEndMs && { nextRenewalAt: periodEndMs }),
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
