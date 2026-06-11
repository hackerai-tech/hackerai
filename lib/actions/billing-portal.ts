"use server";

import { stripe } from "../../app/api/stripe";
import { getBillingActionContext } from "@/lib/actions/billing-context";

export default async function redirectToBillingPortal() {
  const { stripeCustomerId } = await getBillingActionContext();

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  const billingPortalSession = await stripe.billingPortal.sessions.create({
    customer: stripeCustomerId,
    return_url: `${baseUrl}`,
  });

  if (!billingPortalSession?.url) {
    throw new Error("Failed to create billing portal session");
  }
  return billingPortalSession.url;
}
