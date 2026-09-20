"use server";

import { stripe } from "../../app/api/stripe";
import { isExpectedBillingContextError } from "@/lib/actions/billing-action-errors";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { phLogger } from "@/lib/posthog/server";
import { getExtraUsageReturnUrl } from "@/lib/billing/extra-usage-return";
import type {
  BillingPortalFlow,
  BillingPortalOptions,
} from "@/lib/billing/api-types";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { assertUserCanStartBillingTransaction } from "@/lib/suspensions";

export default async function redirectToBillingPortal(
  flow?: BillingPortalFlow,
  options?: BillingPortalOptions,
) {
  const startedAt = Date.now();
  const context = await getBillingActionContext().catch((error) => {
    if (isExpectedBillingContextError(error)) {
      throw error;
    }

    phLogger.error("billing_portal_action_failed", {
      event: "billing_portal_action_failed",
      stage: "billing_context",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  });
  await assertUserCanStartBillingTransaction(context.user.id);
  const stripeCustomerId = context.stripeCustomerId;
  const billingFields = {
    userId: context.user.id,
    org_id: context.organizationId,
    stripe_customer_id: stripeCustomerId,
  };

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const returnUrl = options?.returnPath
    ? getExtraUsageReturnUrl(baseUrl!, options.returnPath)
    : null;
  if (returnUrl && options?.surface === "blocked_chat") {
    returnUrl.searchParams.set("refresh", "entitlements");
  }
  let billingPortalSession:
    | Awaited<ReturnType<typeof stripe.billingPortal.sessions.create>>
    | undefined;
  try {
    billingPortalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: returnUrl?.toString() ?? `${baseUrl}`,
      ...(flow === "payment_method" && {
        flow_data: { type: "payment_method_update" },
      }),
    });
  } catch (error) {
    phLogger.error("billing_portal_action_failed", {
      event: "billing_portal_action_failed",
      ...billingFields,
      stage: "stripe_session_create",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  if (!billingPortalSession?.url) {
    const error = new Error("Failed to create billing portal session");
    phLogger.error("billing_portal_action_failed", {
      event: "billing_portal_action_failed",
      ...billingFields,
      stage: "missing_session_url",
      duration_ms: Date.now() - startedAt,
      error,
    });
    throw error;
  }

  if (flow === "payment_method") {
    phLogger.event(
      PAID_FUNNEL_EVENTS.paymentUpdateOpened,
      paidFunnelProperties({
        ...billingFields,
        surface: options?.surface ?? "account_settings",
        stripe_billing_portal_session_id: billingPortalSession.id,
        $insert_id: `${PAID_FUNNEL_EVENTS.paymentUpdateOpened}:${billingPortalSession.id}:${context.user.id}`,
      }),
    );
  }

  return billingPortalSession.url;
}
