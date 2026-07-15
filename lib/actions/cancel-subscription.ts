"use server";

import type Stripe from "stripe";
import { stripe } from "../../app/api/stripe";
import { api } from "@/convex/_generated/api";
import {
  isExpectedBillingContextError,
  isExpectedSubscriptionLookupError,
} from "@/lib/actions/billing-action-errors";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import {
  isCancellationReasonCategory,
  normalizeCancellationReasonDetails,
  type CancellationReasonCategory,
} from "@/lib/billing/cancellation-reasons";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";
import {
  PAID_FUNNEL_EVENTS,
  cancellationCompletionInsertId,
  paidFunnelProperties,
  planLookupKeyToTier,
} from "@/lib/analytics/paid-funnel";
import type { SubscriptionTier } from "@/types";

type CancellationReasonInput = {
  reasonCategory?: unknown;
  reasonDetails?: unknown;
};

type CancelSubscriptionInput = {
  cancellationReason?: CancellationReasonInput;
};

type ParsedCancellationReasonInput = {
  reasonCategory: CancellationReasonCategory;
  reasonDetails: string;
};

type SubscriptionContext = {
  id: string;
  status: Stripe.Subscription.Status;
  priceId?: string;
  plan?: string;
  tier?: SubscriptionTier;
  currentPeriodEnd?: number;
  cancelAtPeriodEnd: boolean;
};

function parseCancellationReasonInput(
  value: CancelSubscriptionInput["cancellationReason"],
): ParsedCancellationReasonInput {
  const reasonCategory = value?.reasonCategory;
  const reasonDetails = normalizeCancellationReasonDetails(
    value?.reasonDetails,
  );

  if (!isCancellationReasonCategory(reasonCategory)) {
    throw new Error("Please select the main cancellation reason");
  }

  if (!reasonDetails) {
    throw new Error("Please write a cancellation reason before continuing");
  }

  return {
    reasonCategory,
    reasonDetails,
  };
}

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

function subscriptionTierFromLookupKey(
  lookupKey: string | null | undefined,
): SubscriptionTier | undefined {
  return planLookupKeyToTier(lookupKey ?? undefined) ?? undefined;
}

function currentPeriodEndMs(subscription: unknown): number | undefined {
  const currentPeriodEnd = (subscription as { current_period_end?: unknown })
    .current_period_end;
  return typeof currentPeriodEnd === "number" &&
    Number.isFinite(currentPeriodEnd) &&
    currentPeriodEnd > 0
    ? currentPeriodEnd * 1000
    : undefined;
}

async function getActiveSubscriptionContext(
  stripeCustomerId: string,
): Promise<SubscriptionContext> {
  const subscriptions = await stripe.subscriptions.list({
    customer: stripeCustomerId,
    status: "all",
    limit: 10,
    expand: ["data.items.data.price"],
  });
  const currentSubscription = subscriptions.data.find((subscription) =>
    ["active", "trialing", "past_due", "unpaid"].includes(subscription.status),
  );

  if (!currentSubscription) {
    throw new Error("No active subscription found");
  }

  const price = currentSubscription.items.data[0]?.price;
  return {
    id: currentSubscription.id,
    status: currentSubscription.status,
    priceId: price?.id,
    plan: price?.lookup_key ?? undefined,
    tier: subscriptionTierFromLookupKey(price?.lookup_key),
    currentPeriodEnd: currentPeriodEndMs(currentSubscription),
    cancelAtPeriodEnd: currentSubscription.cancel_at_period_end === true,
  };
}

function shouldCancelImmediately(status: Stripe.Subscription.Status) {
  return status === "past_due" || status === "unpaid";
}

function stripeCancellationFeedback(
  reasonCategory: CancellationReasonCategory,
) {
  if (reasonCategory === "too_expensive") return "too_expensive";
  if (reasonCategory === "missing_feature") return "missing_features";
  if (reasonCategory === "switched_tool") return "switched_service";
  if (reasonCategory === "not_using_enough") return "unused";
  return "other";
}

export default async function cancelSubscriptionAction(
  input: CancelSubscriptionInput,
) {
  const cancellationReason = parseCancellationReasonInput(
    input.cancellationReason,
  );
  const startedAt = Date.now();
  const context = await getBillingActionContext().catch((error) => {
    if (isExpectedBillingContextError(error)) {
      throw error;
    }

    phLogger.error("billing_subscription_cancellation_action_failed", {
      event: "billing_subscription_cancellation_action_failed",
      stage: "billing_context",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  });
  const { organizationId, user, stripeCustomerId } = context;
  const billingFields = {
    userId: user.id,
    org_id: organizationId,
    stripe_customer_id: stripeCustomerId,
  };

  let subscriptionContext: SubscriptionContext;
  try {
    subscriptionContext = await getActiveSubscriptionContext(stripeCustomerId);
  } catch (error) {
    if (isExpectedSubscriptionLookupError(error)) {
      throw error;
    }

    phLogger.error("billing_subscription_cancellation_action_failed", {
      event: "billing_subscription_cancellation_action_failed",
      ...billingFields,
      stage: "stripe_subscription_lookup",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  const cancelImmediately = shouldCancelImmediately(subscriptionContext.status);

  if (subscriptionContext.cancelAtPeriodEnd && !cancelImmediately) {
    return {
      canceled: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: subscriptionContext.currentPeriodEnd,
      alreadyScheduled: true,
    };
  }

  const now = Date.now();
  const accountCreatedAt = parseCreatedAtMs(user);
  const accountAgeDays = accountCreatedAt
    ? Math.max(0, Math.floor((now - accountCreatedAt) / 86_400_000))
    : undefined;
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
  let cancellationStartRecorded = false;
  let shouldEmitCancellationCompleted = true;

  if (serviceKey) {
    try {
      await getConvexClient().mutation(
        api.cancellationReasons.recordCancellationStarted,
        {
          serviceKey,
          userId: user.id,
          organizationId,
          stripeCustomerId,
          stripeSubscriptionId: subscriptionContext.id,
          stripePriceId: subscriptionContext.priceId,
          plan: subscriptionContext.plan,
          subscriptionTier: subscriptionContext.tier,
          reasonCategory: cancellationReason.reasonCategory,
          reasonDetails: cancellationReason.reasonDetails,
          accountCreatedAt,
          accountAgeDays,
          startedAt: now,
          source: "in_app",
        },
      );
      cancellationStartRecorded = true;
    } catch (error) {
      phLogger.error("Failed to record cancellation reason", {
        userId: user.id,
        org_id: organizationId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: subscriptionContext.id,
        error,
      });
    }
  } else {
    phLogger.error("Failed to record cancellation reason", {
      userId: user.id,
      org_id: organizationId,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: subscriptionContext.id,
      error: new Error("CONVEX_SERVICE_ROLE_KEY is not set"),
    });
  }

  let updatedSubscription: Stripe.Subscription;
  try {
    const cancellationDetails = {
      feedback: stripeCancellationFeedback(cancellationReason.reasonCategory),
    } as const;

    updatedSubscription = cancelImmediately
      ? await stripe.subscriptions.cancel(subscriptionContext.id, {
          cancellation_details: cancellationDetails,
          invoice_now: false,
          prorate: false,
        })
      : await stripe.subscriptions.update(subscriptionContext.id, {
          cancel_at_period_end: true,
          cancellation_details: cancellationDetails,
        });
  } catch (error) {
    phLogger.error("billing_subscription_cancellation_action_failed", {
      event: "billing_subscription_cancellation_action_failed",
      ...billingFields,
      stage: cancelImmediately
        ? "stripe_subscription_cancel"
        : "stripe_subscription_update",
      stripe_subscription_id: subscriptionContext.id,
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  const completedAt = updatedSubscription.canceled_at
    ? updatedSubscription.canceled_at * 1000
    : Date.now();

  if (serviceKey) {
    try {
      const result = await getConvexClient().mutation(
        api.cancellationReasons.markCancellationCompleted,
        {
          serviceKey,
          stripeSubscriptionId: subscriptionContext.id,
          stripeCustomerId,
          userIds: [user.id],
          organizationId,
          subscriptionTier: subscriptionContext.tier,
          stripeCancellationReason:
            updatedSubscription.cancellation_details?.reason ?? undefined,
          cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
          completedAt,
        },
      );
      shouldEmitCancellationCompleted =
        !cancellationStartRecorded || result.updatedCount > 0;
    } catch (error) {
      phLogger.warn("cancellation_reason_completion_update_failed", {
        userId: user.id,
        org_id: organizationId,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: subscriptionContext.id,
        error,
      });
    }
  }

  phLogger.event(
    PAID_FUNNEL_EVENTS.cancellationReasonSubmitted,
    paidFunnelProperties({
      userId: user.id,
      org_id: organizationId,
      subscription_tier: subscriptionContext.tier,
      plan: subscriptionContext.plan,
      reason_category: cancellationReason.reasonCategory,
      reason_details_length: cancellationReason.reasonDetails.length,
      stripe_customer_id: stripeCustomerId,
      stripe_subscription_id: subscriptionContext.id,
    }),
  );
  if (shouldEmitCancellationCompleted) {
    phLogger.event(
      PAID_FUNNEL_EVENTS.cancellationCompleted,
      paidFunnelProperties({
        userId: user.id,
        org_id: organizationId,
        subscription_tier: subscriptionContext.tier,
        plan: subscriptionContext.plan,
        reason_category: cancellationReason.reasonCategory,
        cancellation_completion_type: cancelImmediately
          ? "immediate_in_app"
          : "scheduled_in_app",
        cancel_at_period_end: updatedSubscription.cancel_at_period_end,
        stripe_customer_id: stripeCustomerId,
        stripe_subscription_id: subscriptionContext.id,
        stripe_price_id: subscriptionContext.priceId,
        $insert_id: cancellationCompletionInsertId(subscriptionContext.id),
      }),
    );
  }

  return {
    canceled: true,
    cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
    ...(updatedSubscription.cancel_at_period_end
      ? {
          currentPeriodEnd:
            currentPeriodEndMs(updatedSubscription) ??
            subscriptionContext.currentPeriodEnd,
        }
      : {}),
    alreadyScheduled: false,
  };
}
