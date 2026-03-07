import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

/** Extra usage pricing multiplier */
export const EXTRA_USAGE_MULTIPLIER = 1.1;

export interface ExtraUsageBalance {
  balanceDollars: number;
  enabled: boolean;
  autoReloadEnabled: boolean;
  autoReloadThresholdDollars?: number;
  autoReloadAmountDollars?: number;
}

export interface DeductBalanceResult {
  success: boolean;
  newBalanceDollars: number;
  insufficientFunds: boolean;
  monthlyCapExceeded: boolean;
  autoReloadTriggered?: boolean;
  autoReloadResult?: {
    success: boolean;
    chargedAmountDollars?: number;
    reason?: string;
  };
  /** True if no deduction was performed (e.g., amount <= 0) */
  noOp?: boolean;
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
      enabled: settings.enabled,
      autoReloadEnabled: settings.autoReloadEnabled,
      autoReloadThresholdDollars: settings.autoReloadThresholdDollars,
      autoReloadAmountDollars: settings.autoReloadAmountDollars,
    };
  } catch (error) {
    console.error("Error getting extra usage balance:", error);
    return null;
  }
}

export interface RefundBalanceResult {
  success: boolean;
  newBalanceDollars: number;
  /** True if no refund was performed (e.g., amount <= 0) */
  noOp?: boolean;
}

/**
 * Refund dollars to user's prepaid balance (for failed requests).
 * This is the reverse of deductFromBalance.
 *
 * @param userId - User ID
 * @param amountDollars - Dollar amount to refund
 */
export async function refundToBalance(
  userId: string,
  amountDollars: number,
): Promise<RefundBalanceResult> {
  if (amountDollars <= 0) {
    return {
      success: true,
      newBalanceDollars: 0,
      noOp: true,
    };
  }

  try {
    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

    const result = await convex.mutation(api.extraUsage.refundBalance, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
      amountDollars,
    });

    return {
      success: result.success,
      newBalanceDollars: result.newBalanceDollars,
    };
  } catch (error) {
    console.error("Error refunding to balance:", error);
    return {
      success: false,
      newBalanceDollars: 0,
    };
  }
}

/**
 * Deduct from user's prepaid balance for extra usage.
 * Also triggers auto-reload if enabled and balance is below threshold.
 * All logic is handled internally by the Convex action.
 *
 * @param userId - User ID
 * @param amountDollars - Dollar amount to deduct
 */
export async function deductFromBalance(
  userId: string,
  amountDollars: number,
): Promise<DeductBalanceResult> {
  if (amountDollars <= 0) {
    return {
      success: true,
      newBalanceDollars: 0,
      insufficientFunds: false,
      monthlyCapExceeded: false,
      noOp: true,
    };
  }

  try {
    const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

    const result = await convex.action(
      api.extraUsageActions.deductWithAutoReload,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        amountDollars,
      },
    );

    return {
      success: result.success,
      newBalanceDollars: result.newBalanceDollars,
      insufficientFunds: result.insufficientFunds,
      monthlyCapExceeded: result.monthlyCapExceeded,
      autoReloadTriggered: result.autoReloadTriggered,
      autoReloadResult: result.autoReloadResult,
    };
  } catch (error) {
    console.error("Error deducting from balance:", error);
    return {
      success: false,
      newBalanceDollars: 0,
      insufficientFunds: true,
      monthlyCapExceeded: false,
    };
  }
}
