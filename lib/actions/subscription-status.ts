"use server";

import { stripe } from "../../app/api/stripe";
import { isExpectedBillingContextError } from "@/lib/actions/billing-action-errors";
import { getBillingStatusContext } from "@/lib/actions/billing-context";
import { phLogger } from "@/lib/posthog/server";
import type { SubscriptionCancellationStatus } from "@/lib/billing/api-types";
import {
  subscriptionCurrentPeriodEndMs,
  subscriptionPlanFromPrice,
} from "@/lib/billing/current-subscription";
import { subscriptionPauseFromMetadata } from "@/lib/billing/retention-offers";
import { resolvePendingPlanChange } from "@/lib/billing/subscription-schedule";
import { hasRecentCanceledRenewalAtRisk } from "@/lib/billing/canceled-renewal-invoice";
import { isPayableRenewalInvoice } from "@/lib/billing/renewal-invoice";
import { planLookupKeyToTier } from "@/lib/analytics/paid-funnel";
import {
  invoicePaymentIntentId,
  paymentFailureGroup,
  stripeObjectId,
} from "@/lib/billing/subscription-payment-failure";

type CurrentSubscriptionStatus = NonNullable<
  SubscriptionCancellationStatus["subscriptionStatus"]
>;

function isCurrentSubscriptionStatus(
  status: string,
): status is CurrentSubscriptionStatus {
  return ["active", "trialing", "past_due", "unpaid"].includes(status);
}

function hasCurrentSubscriptionStatus<T extends { status: string }>(
  subscription: T,
): subscription is T & { status: CurrentSubscriptionStatus } {
  return isCurrentSubscriptionStatus(subscription.status);
}

export default async function getSubscriptionCancellationStatusAction(): Promise<SubscriptionCancellationStatus> {
  const startedAt = Date.now();
  const context = await getBillingStatusContext().catch((error) => {
    if (isExpectedBillingContextError(error)) {
      throw error;
    }

    phLogger.error("billing_subscription_status_action_failed", {
      event: "billing_subscription_status_action_failed",
      stage: "billing_context",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  });
  if (!context) {
    return { hasActiveSubscription: false, cancelAtPeriodEnd: false };
  }
  const stripeCustomerId = context.stripeCustomerId;
  const billingFields = {
    userId: context.user.id,
    org_id: context.organizationId,
    stripe_customer_id: stripeCustomerId,
  };

  let subscriptions: Awaited<ReturnType<typeof stripe.subscriptions.list>>;
  try {
    subscriptions = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      status: "all",
      limit: 10,
      expand: [
        "data.items.data.price",
        "data.schedule",
        "data.latest_invoice",
        "data.latest_invoice.payments",
      ],
    });
  } catch (error) {
    phLogger.error("billing_subscription_status_action_failed", {
      event: "billing_subscription_status_action_failed",
      ...billingFields,
      stage: "stripe_subscription_list",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  }
  const currentSubscriptions = subscriptions.data.filter(
    hasCurrentSubscriptionStatus,
  );
  // A customer can temporarily retain overlapping subscriptions after checkout
  // or migration. Never choose a card-recovery target from ambiguous or partial
  // history; both Account settings and blocked chat must request billing review.
  if (subscriptions.has_more || currentSubscriptions.length > 1) {
    throw new Error("Unable to determine a single current subscription");
  }
  const currentSubscription = currentSubscriptions[0];

  if (!currentSubscription) {
    let checkoutRequiresReview: boolean;
    let billingReviewUnavailable = false;
    try {
      checkoutRequiresReview = await hasRecentCanceledRenewalAtRisk(
        stripe,
        stripeCustomerId,
      );
    } catch (error) {
      phLogger.error("billing_subscription_status_action_failed", {
        event: "billing_subscription_status_action_failed",
        ...billingFields,
        stage: "canceled_renewal_risk",
        duration_ms: Date.now() - startedAt,
        error,
      });
      checkoutRequiresReview = true;
      billingReviewUnavailable = true;
    }
    return {
      hasActiveSubscription: false,
      cancelAtPeriodEnd: false,
      billingAccountAvailable: true,
      checkoutRequiresReview,
      ...(billingReviewUnavailable && { billingReviewUnavailable: true }),
    };
  }

  const invoice = currentSubscription.latest_invoice;
  const renewalPaymentRequired =
    ["past_due", "unpaid"].includes(currentSubscription.status) &&
    currentSubscription.collection_method === "charge_automatically" &&
    !currentSubscription.cancel_at_period_end &&
    !currentSubscription.cancel_at &&
    !currentSubscription.pause_collection &&
    typeof invoice === "object" &&
    invoice !== null &&
    invoice.status === "open" &&
    invoice.collection_method === "charge_automatically" &&
    invoice.billing_reason === "subscription_cycle" &&
    invoice.amount_remaining > 0;
  const latestInvoiceId = stripeObjectId(currentSubscription.latest_invoice);
  let renewalPaymentFailure: SubscriptionCancellationStatus["renewalPaymentFailure"];
  if (renewalPaymentRequired && typeof invoice === "object" && invoice) {
    const paymentIntentId = invoicePaymentIntentId(invoice);
    if (paymentIntentId) {
      try {
        const paymentIntent =
          await stripe.paymentIntents.retrieve(paymentIntentId);
        const paymentError = paymentIntent.last_payment_error;
        if (paymentError) {
          const group = paymentFailureGroup({
            failureCode: paymentError.code,
            declineCode: paymentError.decline_code,
          });
          renewalPaymentFailure =
            group === "insufficient_funds"
              ? "insufficient_funds"
              : group === "authentication_failed"
                ? "authentication_required"
                : "declined";
        }
      } catch (error) {
        // The open invoice remains authoritative if Stripe cannot provide the
        // attempt detail. Do not turn a status check into a billing outage.
        phLogger.error("billing_renewal_attempt_lookup_failed", {
          event: "billing_renewal_attempt_lookup_failed",
          ...billingFields,
          stripe_invoice_id: latestInvoiceId,
          error,
        });
      }
    }
  }
  const item = currentSubscription.items?.data[0];
  const price = item?.price;
  const renewalAmountDollars =
    price?.unit_amount == null
      ? undefined
      : (price.unit_amount * (item.quantity ?? 1)) / 100;
  const cancelAtPeriodEnd = currentSubscription.cancel_at_period_end === true;
  const currentPeriodEnd = subscriptionCurrentPeriodEndMs(currentSubscription);
  const pause = cancelAtPeriodEnd
    ? subscriptionPauseFromMetadata(currentSubscription.metadata)
    : null;
  const pendingChange = await resolvePendingPlanChange(
    currentSubscription.schedule,
    price?.id,
  );
  const pendingPrice = pendingChange?.price;
  return {
    billingAccountAvailable: true,
    ...(renewalPaymentRequired &&
      typeof invoice === "object" &&
      invoice && {
        renewalInvoiceAmountRemaining: invoice.amount_remaining,
        renewalInvoiceCurrency: invoice.currency,
        renewalInvoicePayable: isPayableRenewalInvoice(
          currentSubscription,
          invoice,
          stripeCustomerId,
        ),
      }),
    hasActiveSubscription: true,
    cancelAtPeriodEnd,
    currentPeriodEnd,
    subscriptionStatus: currentSubscription.status,
    ...(pause && {
      pause: {
        months: pause.months,
        resumeAt: pause.resumeAtMs,
        ...(currentPeriodEnd && { pauseEffectiveAt: currentPeriodEnd }),
      },
    }),
    ...(pendingChange && {
      pendingPlanChange: {
        effectiveAt: pendingChange.effectiveAtMs,
        ...(pendingPrice?.lookup_key && {
          targetPlan: pendingPrice.lookup_key,
          targetTier: planLookupKeyToTier(pendingPrice.lookup_key) ?? undefined,
        }),
        ...(typeof pendingPrice?.unit_amount === "number" && {
          targetAmountDollars: pendingPrice.unit_amount / 100,
        }),
        ...(pendingPrice?.currency && { currency: pendingPrice.currency }),
      },
    }),
    ...(latestInvoiceId && { latestInvoiceId }),
    ...(renewalPaymentRequired && { renewalPaymentRequired: true }),
    ...(typeof invoice === "object" &&
      invoice?.billing_reason === "subscription_cycle" &&
      invoice.status === "paid" && { renewalInvoicePaid: true }),
    ...(renewalPaymentFailure && { renewalPaymentFailure }),
    ...(price?.id && { stripePriceId: price.id }),
    ...(subscriptionPlanFromPrice(price) && {
      stripePriceLookupKey: subscriptionPlanFromPrice(price),
    }),
    ...(renewalAmountDollars !== undefined && { renewalAmountDollars }),
    ...(price?.currency && { renewalCurrency: price.currency }),
    ...(price?.recurring?.interval && {
      renewalInterval: price.recurring.interval,
    }),
    ...(price?.recurring?.interval_count && {
      renewalIntervalCount: price.recurring.interval_count,
    }),
  };
}
