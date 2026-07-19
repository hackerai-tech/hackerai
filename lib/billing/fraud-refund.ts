import type Stripe from "stripe";

export function getRemainingRefundAmountCents(
  charge: Pick<Stripe.Charge, "amount" | "amount_refunded">,
): number {
  return Math.max(0, charge.amount - charge.amount_refunded);
}

export function isRefundAmountRaceError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const stripeError = error as { message?: unknown; statusCode?: unknown };
  return (
    stripeError.statusCode === 400 &&
    typeof stripeError.message === "string" &&
    stripeError.message.includes("Refund amount (") &&
    stripeError.message.includes("is greater than unrefunded amount on charge")
  );
}
