import type Stripe from "stripe";

export function getRemainingRefundAmountCents(
  charge: Pick<Stripe.Charge, "amount" | "amount_refunded">,
): number {
  return Math.max(0, charge.amount - charge.amount_refunded);
}
