import type Stripe from "stripe";
import type { FunctionReturnType } from "convex/server";

import { stripe } from "@/app/api/stripe";
import { api } from "@/convex/_generated/api";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { BILLING_ERRORS } from "@/lib/billing/billing-errors";
import { CURRENT_SUBSCRIPTION_STATUSES } from "@/lib/billing/current-subscription";
import {
  PAUSE_RESUME_CHECKOUT_TYPE,
  PAUSE_RESUME_MAX_ATTEMPTS,
  PAUSE_RESUME_RETRY_DELAY_MS,
} from "@/lib/billing/retention-offers";
import { isTerminalStripeResourceError } from "@/lib/billing/stripe-terminal-errors";
import { stripeObjectId } from "@/lib/billing/subscription-payment-failure";
import { getConvexClient } from "@/lib/db/convex-client";
import { phLogger } from "@/lib/posthog/server";

export type SubscriptionPauseRecord = NonNullable<
  FunctionReturnType<typeof api.subscriptionPauses.getActivePauseForUser>
>;

export type ResumeTrigger = "manual" | "cron";

export type ResumePausedSubscriptionOutcome =
  | { outcome: "resumed"; stripeSubscriptionId: string }
  | { outcome: "superseded"; stripeSubscriptionId: string }
  | { outcome: "not_claimable" }
  | {
      outcome: "failed";
      failureKind: "payment_failed" | "no_payment_method" | "unexpected";
      retryScheduled: boolean;
      message: string;
    };

const PAYMENT_METHOD_MISSING_MESSAGE = BILLING_ERRORS.resumeNoPaymentMethod;

function serviceKey(): string {
  const key = process.env.CONVEX_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error("CONVEX_SERVICE_ROLE_KEY is not set");
  }
  return key;
}

function isStripeCardError(error: unknown): boolean {
  const type =
    error && typeof error === "object"
      ? (error as { type?: unknown }).type
      : undefined;
  return type === "StripeCardError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function findLiveSubscription(
  customerId: string,
): Promise<Stripe.Subscription | undefined> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 10,
  });
  return subscriptions.data.find(
    (subscription) =>
      CURRENT_SUBSCRIPTION_STATUSES.has(subscription.status) ||
      subscription.status === "incomplete",
  );
}

async function resolvePaymentMethodId(
  pause: SubscriptionPauseRecord,
): Promise<string | undefined> {
  if (pause.stripePaymentMethodId) {
    try {
      const paymentMethod = await stripe.paymentMethods.retrieve(
        pause.stripePaymentMethodId,
      );
      if (stripeObjectId(paymentMethod.customer) === pause.stripeCustomerId) {
        return paymentMethod.id;
      }
    } catch (error) {
      if (!isTerminalStripeResourceError(error)) throw error;
    }
  }

  const customer = await stripe.customers.retrieve(pause.stripeCustomerId);
  if (customer.deleted) return undefined;
  const customerDefault = stripeObjectId(
    customer.invoice_settings?.default_payment_method,
  );
  if (customerDefault) return customerDefault;

  const paymentMethods = await stripe.paymentMethods.list({
    customer: pause.stripeCustomerId,
    limit: 1,
  });
  return paymentMethods.data[0]?.id;
}

function pauseAnalyticsProperties(
  pause: SubscriptionPauseRecord,
  trigger: ResumeTrigger,
) {
  return {
    userId: pause.userId,
    org_id: pause.organizationId,
    subscription_tier: pause.subscriptionTier,
    plan: pause.stripePriceLookupKey,
    stripe_price_lookup_key: pause.stripePriceLookupKey,
    stripe_customer_id: pause.stripeCustomerId,
    paused_stripe_subscription_id: pause.stripeSubscriptionId,
    stripe_price_id: pause.stripePriceId,
    pause_months: pause.pauseMonths,
    pause_id: pause.id,
    resume_trigger: trigger,
    resume_attempt_count: pause.resumeAttemptCount,
  };
}

/**
 * Re-create the paused subscription with the same price and the saved card.
 * Safe to call from the hourly cron and from the user's "Resume now" button:
 * the Convex claim makes concurrent attempts a no-op, and an existing live
 * subscription marks the pause superseded instead of double-billing.
 */
export async function resumePausedSubscription(
  pause: SubscriptionPauseRecord,
  options: { trigger: ResumeTrigger; now?: number },
): Promise<ResumePausedSubscriptionOutcome> {
  const now = options.now ?? Date.now();
  const convex = getConvexClient();
  const key = serviceKey();
  const manual = options.trigger === "manual";

  const claimed = await convex.mutation(api.subscriptionPauses.claimResume, {
    serviceKey: key,
    pauseId: pause.id,
    now,
    manual,
    maxAttempts: PAUSE_RESUME_MAX_ATTEMPTS,
  });
  if (!claimed) {
    return { outcome: "not_claimable" };
  }

  const analytics = pauseAnalyticsProperties(claimed, options.trigger);

  try {
    const liveSubscription = await findLiveSubscription(
      claimed.stripeCustomerId,
    );
    if (liveSubscription) {
      await convex.mutation(api.subscriptionPauses.markPauseSuperseded, {
        serviceKey: key,
        pauseId: claimed.id,
        stripeSubscriptionId: liveSubscription.id,
        supersededAt: now,
      });
      phLogger.info("subscription_pause_superseded", {
        event: "subscription_pause_superseded",
        ...analytics,
        stripe_subscription_id: liveSubscription.id,
      });
      return {
        outcome: "superseded",
        stripeSubscriptionId: liveSubscription.id,
      };
    }

    const paymentMethodId = await resolvePaymentMethodId(claimed);
    if (!paymentMethodId) {
      await convex.mutation(api.subscriptionPauses.markResumeFailed, {
        serviceKey: key,
        pauseId: claimed.id,
        error: "no_payment_method",
        failedAt: now,
      });
      phLogger.event(
        PAID_FUNNEL_EVENTS.subscriptionPauseResumeFailed,
        paidFunnelProperties({
          ...analytics,
          failure_kind: "no_payment_method",
          retry_scheduled: false,
          $insert_id: `${PAID_FUNNEL_EVENTS.subscriptionPauseResumeFailed}:${claimed.id}:${claimed.resumeAttemptCount}`,
        }),
      );
      return {
        outcome: "failed",
        failureKind: "no_payment_method",
        retryScheduled: false,
        message: PAYMENT_METHOD_MISSING_MESSAGE,
      };
    }

    // Scoped to the claim attempt: a retry after a declined card must be a
    // fresh request, while transport-level retries of this attempt cannot
    // create a second subscription.
    const subscription = await stripe.subscriptions.create(
      {
        customer: claimed.stripeCustomerId,
        items: [{ price: claimed.stripePriceId, quantity: claimed.quantity }],
        default_payment_method: paymentMethodId,
        payment_behavior: "error_if_incomplete",
        metadata: {
          checkoutType: PAUSE_RESUME_CHECKOUT_TYPE,
          checkoutSource: PAUSE_RESUME_CHECKOUT_TYPE,
          checkoutSurface: manual ? "account_settings" : "pause_resume_cron",
          hackeraiPauseId: claimed.id,
          hackeraiResumedFromSubscriptionId: claimed.stripeSubscriptionId,
        },
      },
      {
        idempotencyKey: `pause_resume:${claimed.id}:${claimed.resumeAttemptCount}`,
      },
    );

    await convex.mutation(api.subscriptionPauses.markResumeSucceeded, {
      serviceKey: key,
      pauseId: claimed.id,
      resumedStripeSubscriptionId: subscription.id,
      resumedAt: now,
    });

    phLogger.event(
      PAID_FUNNEL_EVENTS.subscriptionPauseResumed,
      paidFunnelProperties({
        ...analytics,
        stripe_subscription_id: subscription.id,
        subscription_status: subscription.status,
        paused_duration_ms: claimed.pauseEffectiveAt
          ? Math.max(0, now - claimed.pauseEffectiveAt)
          : undefined,
        $insert_id: `${PAID_FUNNEL_EVENTS.subscriptionPauseResumed}:${claimed.id}`,
        $set: {
          subscription_tier: claimed.subscriptionTier,
          last_subscription_pause_resumed_at: new Date(now).toISOString(),
        },
      }),
    );

    return { outcome: "resumed", stripeSubscriptionId: subscription.id };
  } catch (error) {
    const paymentFailed = isStripeCardError(error);
    const retryScheduled =
      !manual &&
      paymentFailed &&
      claimed.resumeAttemptCount < PAUSE_RESUME_MAX_ATTEMPTS;

    try {
      await convex.mutation(api.subscriptionPauses.markResumeFailed, {
        serviceKey: key,
        pauseId: claimed.id,
        error: errorMessage(error),
        ...(retryScheduled && { retryAt: now + PAUSE_RESUME_RETRY_DELAY_MS }),
        failedAt: now,
      });
    } catch (markError) {
      phLogger.error("subscription_pause_resume_state_update_failed", {
        event: "subscription_pause_resume_state_update_failed",
        ...analytics,
        error: markError,
      });
    }

    phLogger.event(
      PAID_FUNNEL_EVENTS.subscriptionPauseResumeFailed,
      paidFunnelProperties({
        ...analytics,
        failure_kind: paymentFailed ? "payment_failed" : "unexpected",
        retry_scheduled: retryScheduled,
        $insert_id: `${PAID_FUNNEL_EVENTS.subscriptionPauseResumeFailed}:${claimed.id}:${claimed.resumeAttemptCount}`,
      }),
    );
    if (!paymentFailed) {
      phLogger.error("subscription_pause_resume_failed", {
        event: "subscription_pause_resume_failed",
        ...analytics,
        error,
      });
    }

    return {
      outcome: "failed",
      failureKind: paymentFailed ? "payment_failed" : "unexpected",
      retryScheduled,
      message: paymentFailed
        ? BILLING_ERRORS.resumePaymentFailed
        : errorMessage(error),
    };
  }
}
