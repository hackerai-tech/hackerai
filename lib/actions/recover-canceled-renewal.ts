"use server";

import { stripe } from "@/app/api/stripe";
import { getBillingActionContext } from "@/lib/actions/billing-context";
import { recoverCanceledRenewalsForCheckout } from "@/lib/billing/canceled-renewal-invoice";
import { phLogger } from "@/lib/posthog/server";
import { assertUserCanStartBillingTransaction } from "@/lib/suspensions";

/** The authenticated billing owner selects the customer, never client input. */
export default async function recoverCanceledRenewal(): Promise<boolean> {
  const context = await getBillingActionContext();
  await assertUserCanStartBillingTransaction(context.user.id);
  try {
    const ready = await recoverCanceledRenewalsForCheckout(
      stripe,
      context.stripeCustomerId,
    );
    phLogger.info("billing_canceled_renewal_recovery", {
      userId: context.user.id,
      org_id: context.organizationId,
      stripe_customer_id: context.stripeCustomerId,
      checkout_ready: ready,
    });
    return ready;
  } catch (error) {
    phLogger.error("billing_canceled_renewal_recovery_failed", {
      userId: context.user.id,
      org_id: context.organizationId,
      error,
    });
    throw new Error(
      "We couldn't prepare your new subscription. Check payment status or try again.",
    );
  }
}
