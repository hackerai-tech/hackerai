import { POINTS_PER_DOLLAR } from "@/lib/rate-limit/token-bucket";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

/** Extra usage pricing multiplier */
export const EXTRA_USAGE_MULTIPLIER = 1.5;

export interface ExtraUsageBalance {
  balanceDollars: number;
  balancePoints: number;
  enabled: boolean;
  autoReloadEnabled: boolean;
  autoReloadThresholdDollars?: number;
  autoReloadThresholdPoints?: number;
  autoReloadAmountDollars?: number;
}

export interface DeductBalanceResult {
  success: boolean;
  newBalanceDollars: number;
  insufficientFunds: boolean;
  autoReloadTriggered?: boolean;
  autoReloadResult?: {
    success: boolean;
    chargedAmountDollars?: number;
    reason?: string;
  };
}

/**
 * Convert points to dollars at the extra usage rate.
 * Points are internal units (1 point = $0.0001)
 */
export function pointsToDollars(points: number): number {
  const dollars = (points / POINTS_PER_DOLLAR) * EXTRA_USAGE_MULTIPLIER;
  return Math.ceil(dollars * 100) / 100; // Round up to nearest cent
}

/**
 * Get user's extra usage balance and settings.
 * Used by the rate limit logic to check if user can use extra usage.
 */
export async function getExtraUsageBalance(
  userId: string,
): Promise<ExtraUsageBalance | null> {
  try {
    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    const settings = await convex.query(
      api.extraUsage.getExtraUsageBalanceForBackend,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
      },
    );
    return {
      balanceDollars: settings.balanceDollars,
      balancePoints: settings.balancePoints,
      enabled: settings.enabled,
      autoReloadEnabled: settings.autoReloadEnabled,
      autoReloadThresholdDollars: settings.autoReloadThresholdDollars,
      autoReloadThresholdPoints: settings.autoReloadThresholdPoints,
      autoReloadAmountDollars: settings.autoReloadAmountDollars,
    };
  } catch (error) {
    console.error("Error getting extra usage balance:", error);
    return null;
  }
}

/**
 * Deduct from user's prepaid balance for extra usage.
 * Also triggers auto-reload if enabled and balance is below threshold.
 * All logic is handled internally by the Convex action.
 *
 * Passes points directly to Convex to avoid precision loss from dollar conversion.
 *
 * @param userId - User ID
 * @param pointsUsed - Number of points to deduct
 */
export async function deductFromBalance(
  userId: string,
  pointsUsed: number,
): Promise<DeductBalanceResult> {
  if (pointsUsed <= 0) {
    return {
      success: true,
      newBalanceDollars: 0,
      insufficientFunds: false,
    };
  }

  try {
    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

    // Use the Convex action that handles deduction + auto-reload internally
    // Pass points directly to avoid precision loss from dollar conversion
    const result = await convex.action(
      api.extraUsageActions.deductWithAutoReload,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        amountPoints: pointsUsed,
      },
    );

    return {
      success: result.success,
      newBalanceDollars: result.newBalanceDollars,
      insufficientFunds: result.insufficientFunds,
      autoReloadTriggered: result.autoReloadTriggered,
      autoReloadResult: result.autoReloadResult,
    };
  } catch (error) {
    console.error("Error deducting from balance:", error);
    return {
      success: false,
      newBalanceDollars: 0,
      insufficientFunds: true,
    };
  }
}
