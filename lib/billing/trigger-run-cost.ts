export type TriggerRunUsageSource = {
  compute: {
    total: {
      costInCents: number;
      durationMs: number;
    };
  };
  baseCostInCents: number;
  totalCostInCents: number;
};

export type TriggerRunCostBreakdown = {
  totalCostDollars: number;
  computeCostDollars: number;
  baseCostDollars: number;
  durationMs: number;
};

const nonNegativeFinite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/**
 * Converts Trigger.dev's authoritative per-run usage into the dollar amounts
 * used by HackerAI billing. Trigger calculates compute cost from the machine
 * actually assigned to the run, so this automatically distinguishes
 * small-1x, small-2x, retries, and future machine-price changes.
 */
export const resolveTriggerRunCost = (
  usage: TriggerRunUsageSource,
): TriggerRunCostBreakdown => ({
  totalCostDollars: nonNegativeFinite(usage.totalCostInCents) / 100,
  computeCostDollars: nonNegativeFinite(usage.compute.total.costInCents) / 100,
  baseCostDollars: nonNegativeFinite(usage.baseCostInCents) / 100,
  durationMs: nonNegativeFinite(usage.compute.total.durationMs),
});
