/** Immutable offer IDs: retain historical prices so delayed payments remain fulfillable. */
export const EXTRA_USAGE_BUNDLES = [
  {
    id: "usage-50-v1",
    creditDollars: 50,
    paidDollars: 45,
    discountPercent: 10,
  },
  {
    id: "usage-250-v1",
    creditDollars: 250,
    paidDollars: 200,
    discountPercent: 20,
  },
  {
    id: "usage-1000-v1",
    creditDollars: 1000,
    paidDollars: 700,
    discountPercent: 30,
  },
] as const;

/**
 * Monthly limit on discounted bundle face value per personal user, combined
 * across plans and offers. Periods are UTC calendar months, matching wallet
 * billing; a checkout keeps the period it was created in through fulfillment.
 */
export const EXTRA_USAGE_BUNDLE_CAP = {
  policyVersion: "bundle-cap-v1",
  creditDollars: 2000,
} as const;

/** UTC calendar month containing `now`, plus the instant the next one starts. */
export function extraUsageBundleCapPeriod(now: number) {
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return {
    periodMonth: `${year}-${String(month + 1).padStart(2, "0")}`,
    periodStart: Date.UTC(year, month, 1),
    resetsAt: Date.UTC(year, month + 1, 1),
  };
}

/** Resolve a historical offer; never accept prices supplied by a client. */
export function getExtraUsageBundle(id: string) {
  const bundle = EXTRA_USAGE_BUNDLES.find((offer) => offer.id === id);
  if (!bundle) throw new Error("Unknown Extra Usage bundle");
  return bundle;
}

/**
 * Purchase value fields for analytics: cash paid, face credit granted and the
 * discount between them stay distinct, with the cap period the sale used.
 */
export function extraUsagePurchaseValueProperties(
  purchase: ExtraUsagePurchase,
) {
  const paidDollars = purchase.paidAmountDollars ?? purchase.amountDollars;
  return {
    amount_dollars: paidDollars,
    credit_amount_dollars: purchase.amountDollars,
    discount_dollars: purchase.amountDollars - paidDollars,
    bundle_id: purchase.bundleId,
    bundle_cap_policy_version: purchase.bundleCapPolicyVersion,
    bundle_cap_period: purchase.bundleCapPeriod,
  };
}

/** Gate new sales only; never gate fulfillment of an already-paid checkout. */
export function extraUsageBundlesEnabled(userId: string): boolean {
  return (
    process.env.EXTRA_USAGE_BUNDLES_ENABLED === "true" ||
    (process.env.EXTRA_USAGE_BUNDLES_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .includes(userId)
  );
}

export type ExtraUsagePurchase = {
  amountDollars: number;
  paidAmountDollars?: number;
  bundleId?: string;
  bundleReservationId?: string;
  bundleCapPeriod?: string;
  bundleCapPolicyVersion?: string;
};

/** Validate Stripe bundle totals before granting credit, retaining legacy top-ups. */
export function readExtraUsagePurchase(session: {
  metadata: Record<string, string> | null;
  currency?: string | null;
  amount_total?: number | null;
}): ExtraUsagePurchase {
  const metadata = session.metadata ?? {};
  const amountDollars = metadata.amountDollars
    ? Number(metadata.amountDollars)
    : Number(metadata.amountCents) / 100;
  if (!Number.isFinite(amountDollars) || amountDollars <= 0)
    throw new Error("Invalid purchase amount");
  if (!metadata.bundleId) {
    if (metadata.paidAmountDollars !== undefined)
      throw new Error("Paid amount requires a bundle");
    return { amountDollars };
  }
  const bundle = getExtraUsageBundle(metadata.bundleId);
  if (
    amountDollars !== bundle.creditDollars ||
    Number(metadata.paidAmountDollars) !== bundle.paidDollars ||
    session.currency !== "usd" ||
    session.amount_total !== bundle.paidDollars * 100
  ) {
    throw new Error("Bundle payment does not match offer");
  }
  return {
    amountDollars,
    paidAmountDollars: bundle.paidDollars,
    bundleId: bundle.id,
    // Pre-cap sessions have no reservation; fulfillment must still succeed.
    ...(metadata.bundleReservationId && {
      bundleReservationId: metadata.bundleReservationId,
    }),
    ...(metadata.bundleCapPeriod && {
      bundleCapPeriod: metadata.bundleCapPeriod,
    }),
    ...(metadata.bundleCapPolicyVersion && {
      bundleCapPolicyVersion: metadata.bundleCapPolicyVersion,
    }),
  };
}
