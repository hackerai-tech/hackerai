/**
 * Projects when the user's budget will be exhausted based on recent usage.
 */

export interface DailyUsage {
  date: string;
  costDollars: number;
}

export interface UsageProjection {
  /** Date the budget is projected to run out, or null if it will last past reset */
  projectedExhaustionDate: Date | null;
  /** Estimated days remaining at current burn rate, or null if no usage data */
  daysRemaining: number | null;
  /** Average cost per day over the lookback period */
  burnRatePerDay: number;
}

/**
 * Calculate projected budget exhaustion based on recent daily usage.
 *
 * @param remainingDollars - Remaining budget in dollars
 * @param resetTime - When the budget resets (end of billing period)
 * @param recentDailyUsage - Daily cost aggregates (from getDailyUsageSummary)
 */
export function calculateUsageProjection(
  remainingDollars: number,
  resetTime: Date,
  recentDailyUsage: DailyUsage[],
): UsageProjection {
  if (recentDailyUsage.length === 0 || remainingDollars <= 0) {
    return {
      projectedExhaustionDate: null,
      daysRemaining: remainingDollars <= 0 ? 0 : null,
      burnRatePerDay: 0,
    };
  }

  const totalCost = recentDailyUsage.reduce((sum, d) => sum + d.costDollars, 0);
  const burnRatePerDay = totalCost / recentDailyUsage.length;

  if (burnRatePerDay <= 0) {
    return {
      projectedExhaustionDate: null,
      daysRemaining: null,
      burnRatePerDay: 0,
    };
  }

  const daysRemaining = remainingDollars / burnRatePerDay;
  const exhaustionDate = new Date(
    Date.now() + daysRemaining * 24 * 60 * 60 * 1000,
  );

  // If budget will last past reset, no warning needed
  if (exhaustionDate >= resetTime) {
    return {
      projectedExhaustionDate: null,
      daysRemaining: null,
      burnRatePerDay,
    };
  }

  return {
    projectedExhaustionDate: exhaustionDate,
    daysRemaining: Math.round(daysRemaining * 10) / 10,
    burnRatePerDay,
  };
}
