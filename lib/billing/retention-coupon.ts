import { stripe } from "@/app/api/stripe";
import { RETENTION_DISCOUNT } from "@/lib/billing/retention-offers";
import { isTerminalStripeResourceError } from "@/lib/billing/stripe-terminal-errors";

const stripeErrorCode = (error: unknown): string | undefined => {
  const code =
    error && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code : undefined;
};

/**
 * Resolve the Stripe coupon used by the retention discount. An explicitly
 * configured coupon wins; otherwise the deterministic coupon is created once
 * and reused afterwards.
 */
export async function ensureRetentionCoupon(): Promise<string> {
  const configured = process.env.STRIPE_RETENTION_COUPON_ID?.trim();
  if (configured) return configured;

  const couponId = RETENTION_DISCOUNT.couponId;
  try {
    const coupon = await stripe.coupons.retrieve(couponId);
    if (!coupon.valid) {
      throw new Error("Retention coupon is no longer valid");
    }
    return coupon.id;
  } catch (error) {
    if (!isTerminalStripeResourceError(error)) throw error;
  }

  try {
    const created = await stripe.coupons.create({
      id: couponId,
      name: RETENTION_DISCOUNT.couponName,
      percent_off: RETENTION_DISCOUNT.percentOff,
      duration: "repeating",
      duration_in_months: RETENTION_DISCOUNT.durationMonths,
      metadata: { purpose: "retention_offer", source: "hackerai_app" },
    });
    return created.id;
  } catch (error) {
    // Another request created it first.
    if (stripeErrorCode(error) === "resource_already_exists") {
      return couponId;
    }
    throw error;
  }
}
