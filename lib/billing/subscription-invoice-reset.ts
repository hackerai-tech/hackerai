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

/** Immutable facts recorded on one line of a paid Stripe invoice. */
export type SubscriptionInvoiceLineFacts = {
  subscriptionId?: string;
  priceId?: string;
  proration: boolean;
  amount: number;
  periodStartSeconds?: number;
  periodEndSeconds?: number;
};

export type ReplacedSubscriptionPeriod =
  | {
      kind: "replaced";
      replacedPriceId: string;
      /** End of the old recurring period that the invoice credited back. */
      replacedPeriodEndMs: number;
    }
  | { kind: "not_applicable"; reason: string };

const singleValue = <T>(values: T[]): T | undefined => {
  const distinct = new Set(values);
  return distinct.size === 1 ? values[0] : undefined;
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Identify the old recurring period that a subscription-update invoice
 * replaced with the subscription's current Price and period.
 *
 * Stripe credits unused time on the old Price and charges the new Price
 * through the current item's period end. The charge is either a prorated line
 * starting at the same proration date as the credit, or a full non-prorated
 * period after a billing-anchor reset. Mixed, foreign, same-Price or partial
 * date changes are not treated as a replacement.
 */
export function replacedSubscriptionPeriodFromUpdateInvoice({
  lines,
  subscriptionId,
  newPriceId,
  newPeriodEndSeconds,
}: {
  lines: SubscriptionInvoiceLineFacts[];
  subscriptionId: string;
  newPriceId: string;
  /** The current subscription item's `current_period_end`. */
  newPeriodEndSeconds: number | undefined;
}): ReplacedSubscriptionPeriod {
  const notApplicable = (reason: string): ReplacedSubscriptionPeriod => ({
    kind: "not_applicable",
    reason,
  });

  if (
    lines.some(
      (line) => line.subscriptionId && line.subscriptionId !== subscriptionId,
    )
  ) {
    return notApplicable("other_subscription_lines");
  }
  const target = lines.filter((line) => line.subscriptionId === subscriptionId);
  const chargeLines = target.filter(
    (line) => line.amount > 0 && line.priceId === newPriceId,
  );
  if (chargeLines.length !== 1) {
    return notApplicable("new_period_line_not_unique");
  }
  const [charge] = chargeLines;
  const creditLines = target.filter(
    (line) => line.proration && line.amount < 0,
  );
  if (creditLines.length === 0) return notApplicable("replaced_line_missing");
  if (target.length !== 1 + creditLines.length) {
    return notApplicable("unexpected_subscription_lines");
  }

  const replacedPriceId = singleValue(creditLines.map((line) => line.priceId));
  if (!replacedPriceId || replacedPriceId === newPriceId) {
    return notApplicable("replaced_price_ambiguous");
  }
  const creditStart = singleValue(
    creditLines.map((line) => line.periodStartSeconds),
  );
  const replacedPeriodEndSeconds = singleValue(
    creditLines.map((line) => line.periodEndSeconds),
  );
  if (
    !isPositiveInteger(creditStart) ||
    !isPositiveInteger(replacedPeriodEndSeconds)
  ) {
    return notApplicable("replaced_period_ambiguous");
  }

  const chargeStart = charge.periodStartSeconds;
  const chargeEnd = charge.periodEndSeconds;
  if (
    !isPositiveInteger(newPeriodEndSeconds) ||
    !isPositiveInteger(chargeStart) ||
    chargeEnd !== newPeriodEndSeconds
  ) {
    return notApplicable("new_period_end_mismatch");
  }
  if (charge.proration && chargeStart !== creditStart) {
    return notApplicable("proration_start_mismatch");
  }
  if (
    replacedPeriodEndSeconds <= chargeStart ||
    replacedPeriodEndSeconds >= chargeEnd
  ) {
    return notApplicable("replaced_period_not_overlapping");
  }

  return {
    kind: "replaced",
    replacedPriceId,
    replacedPeriodEndMs: replacedPeriodEndSeconds * 1000,
  };
}
