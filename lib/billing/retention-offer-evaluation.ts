import type Stripe from "stripe";

import { stripe } from "@/app/api/stripe";
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
  evaluateDowngradeOfferEligibility,
  evaluatePauseOfferEligibility,
  retentionDowngradeFromMetadata,
  type DowngradeOfferEligibility,
  type PauseOfferEligibility,
} from "@/lib/billing/retention-offers";
import {
  getDowngradeOfferFlagState,
  getPauseOfferFlagState,
  type RetentionOfferFlagState,
} from "@/lib/billing/retention-offers.server";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

export type DowngradeTargetPrice = {
  priceId: string;
  lookupKey: string;
  unitAmountDollars?: number;
  currency?: string;
  /** Prorated credit for the unused part of the current period, in dollars. */
  proratedCreditDollars?: number;
};

export type RetentionOfferEvaluation = {
  offersEnabled: boolean;
  flagState: RetentionOfferFlagState;
  downgradeFlagState: RetentionOfferFlagState;
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
 * Resolve the Stripe price for the downgrade target and preview the prorated
 * credit. The preview is best effort: the offer still shows without it.
 */
export async function resolveDowngradeTargetPrice(args: {
  subscription: CurrentSubscriptionContext;
  stripeCustomerId: string;
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
    // Fail closed for the downgrade only; the pause offer must still show.
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

  const target: DowngradeTargetPrice = {
    priceId: price.id,
    lookupKey: args.lookupKey,
    unitAmountDollars: priceAmountDollars(price),
    currency: price.currency,
  };

  if (!args.subscription.itemId) return target;

  try {
    const preview = await stripe.invoices.createPreview({
      customer: args.stripeCustomerId,
      subscription: args.subscription.id,
      subscription_details: {
        items: [{ id: args.subscription.itemId, price: price.id, quantity: 1 }],
        proration_behavior: "always_invoice",
        proration_date: Math.floor(Date.now() / 1000),
      },
    });
    const lines: Stripe.InvoiceLineItem[] = [...preview.lines.data];
    if (preview.lines.has_more) {
      for await (const line of stripe.invoices.listLineItems(preview.id, {
        limit: 100,
      })) {
        lines.push(line);
      }
    }
    let credit = 0;
    for (const line of lines) {
      const details = line.parent?.subscription_item_details;
      const isProrationForItem =
        details?.proration === true &&
        details.subscription_item === args.subscription.itemId;
      if (isProrationForItem && line.amount < 0) {
        credit += Math.abs(line.amount) / 100;
      }
    }
    target.proratedCreditDollars = Math.round(credit * 100) / 100;
  } catch (error) {
    phLogger.warn("retention_downgrade_preview_failed", {
      stripe_subscription_id: args.subscription.id,
      error,
    });
  }

  return target;
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
  const [flagState, downgradeFlagState] = await Promise.all([
    getPauseOfferFlagState(args.userId),
    getDowngradeOfferFlagState(args.userId),
  ]);
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
    offersEnabled: downgradeFlagState === "enabled",
    downgradeAlreadyApplied:
      retentionDowngradeFromMetadata(subscription.metadata) !== null,
  });

  const downgradeTarget = downgrade.eligible
    ? await resolveDowngradeTargetPrice({
        subscription,
        stripeCustomerId: args.stripeCustomerId,
        lookupKey: downgrade.target.lookupKey,
      })
    : undefined;

  return {
    offersEnabled,
    flagState,
    downgradeFlagState,
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

export function buildRetentionOffers(
  evaluation: RetentionOfferEvaluation,
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
            ...(downgradeTarget.proratedCreditDollars !== undefined && {
              proratedCreditDollars: downgradeTarget.proratedCreditDollars,
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
) {
  const { pause, downgrade, downgradeTarget, subscription } = evaluation;
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
    downgrade_offer_flag_state: evaluation.downgradeFlagState,
    downgrade_offered: downgrade.eligible && Boolean(downgradeTarget),
    downgrade_ineligibility_reason: downgrade.eligible
      ? downgradeTarget
        ? undefined
        : "no_downgrade_target"
      : downgrade.reason,
    downgrade_target_plan: downgradeTarget?.lookupKey,
    downgrade_prorated_credit_dollars: downgradeTarget?.proratedCreditDollars,
    stripe_subscription_id: subscription.id,
    stripe_price_id: subscription.priceId,
  };
}
