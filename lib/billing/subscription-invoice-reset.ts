type InvoiceForBucketReset = {
  billing_reason?: string | null;
  amount_paid?: number | null;
};

type InvoicePaidBucketResetMode =
  | { mode: "full_reset"; reason: "subscription_create" | "subscription_cycle" }
  | { mode: "subscription_update_proration"; reason: "subscription_update" }
  | { mode: "skip"; reason: string };

const FULL_RESET_BILLING_REASONS = new Set([
  "subscription_create",
  "subscription_cycle",
]);

/**
 * Decide whether a paid subscription invoice should refresh usage credits.
 *
 * Full bucket resets are only safe for first paid subscription invoices and
 * true billing-cycle renewals. Stripe also sends invoice.paid for prorated
 * subscription updates, manual invoices, threshold invoices, and zero/credit
 * invoices; those must not mint a fresh usage budget.
 */
export function getInvoicePaidBucketResetMode(
  invoice: InvoiceForBucketReset,
): InvoicePaidBucketResetMode {
  const billingReason = invoice.billing_reason ?? "unknown";

  if (billingReason === "subscription_update") {
    return {
      mode: "subscription_update_proration",
      reason: "subscription_update",
    };
  }

  if (!FULL_RESET_BILLING_REASONS.has(billingReason)) {
    return { mode: "skip", reason: billingReason };
  }

  if ((invoice.amount_paid ?? 0) <= 0) {
    return { mode: "skip", reason: `${billingReason}:non_positive_amount` };
  }

  return {
    mode: "full_reset",
    reason: billingReason as "subscription_create" | "subscription_cycle",
  };
}
