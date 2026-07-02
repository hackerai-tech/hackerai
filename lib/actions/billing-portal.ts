"use server";

import { stripe } from "../../app/api/stripe";
import { isExpectedBillingContextError } from "@/lib/actions/billing-action-errors";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { phLogger } from "@/lib/posthog/server";

export default async function redirectToBillingPortal() {
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
  const stripeCustomerId = context.stripeCustomerId;
  const billingFields = {
    userId: context.user.id,
    org_id: context.organizationId,
    stripe_customer_id: stripeCustomerId,
  };

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  let billingPortalSession:
    | Awaited<ReturnType<typeof stripe.billingPortal.sessions.create>>
    | undefined;
  try {
    billingPortalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${baseUrl}`,
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
  return billingPortalSession.url;
}
