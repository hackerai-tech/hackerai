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

export function getExtraUsageBundle(id: string) {
  const bundle = EXTRA_USAGE_BUNDLES.find((offer) => offer.id === id);
  if (!bundle) throw new Error("Unknown Extra Usage bundle");
  return bundle;
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

export function readExtraUsagePurchase(session: {
  metadata: Record<string, string> | null;
  currency?: string | null;
  amount_total?: number | null;
}) {
  const metadata = session.metadata ?? {};
  const amountDollars = metadata.amountDollars
    ? Number(metadata.amountDollars)
    : Number(metadata.amountCents) / 100;
  if (!Number.isFinite(amountDollars) || amountDollars <= 0)
    throw new Error("Invalid purchase amount");
  if (!metadata.bundleId) return { amountDollars };
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
  };
}
