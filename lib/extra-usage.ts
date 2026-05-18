import { POINTS_PER_DOLLAR } from "@/lib/rate-limit/token-bucket";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import type { SubscriptionTier } from "@/types";

/** Extra usage pricing multiplier */
export const EXTRA_USAGE_MULTIPLIER = 1.05;

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
  monthlyCapExceeded: boolean;
  trustCapExceeded?: boolean;
  trustCapDollars?: number | null;
  autoReloadTriggered?: boolean;
  autoReloadResult?: {
    success: boolean;
    chargedAmountDollars?: number;
    reason?: string;
  };
  /** True if no deduction was performed (e.g., pointsUsed <= 0) */
  noOp?: boolean;
  /** Team-pool-only: per-member spending cap was the blocker */
  memberCapExceeded?: boolean;
  /** Team-pool-only: admin disabled this member's access to the pool */
  memberDisabled?: boolean;
  /** Team-pool-only: admin disabled the team pool entirely */
  poolDisabled?: boolean;
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
    const convex = getConvexClient();
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
export interface RefundBalanceResult {
  success: boolean;
  newBalanceDollars: number;
  /** True if no refund was performed (e.g., pointsToRefund <= 0) */
  noOp?: boolean;
}

/**
 * Refund points to user's prepaid balance (for failed requests).
 * This is the reverse of deductFromBalance.
 *
 * @param userId - User ID
 * @param pointsToRefund - Number of points to refund
 */
export async function refundToBalance(
  userId: string,
  pointsToRefund: number,
): Promise<RefundBalanceResult> {
  // No-op: nothing to refund, balance unchanged (actual balance not fetched to avoid extra call)
  if (pointsToRefund <= 0) {
    return {
      success: true,
      newBalanceDollars: 0,
      noOp: true,
    };
  }

  try {
    const convex = getConvexClient();

    const result = await convex.mutation(api.extraUsage.refundPoints, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      userId,
      amountPoints: pointsToRefund,
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
 * Passes points directly to Convex to avoid precision loss from dollar conversion.
 *
 * @param userId - User ID
 * @param pointsUsed - Number of points to deduct
 * @param subscription - Paid tier used for plan-based extra usage caps
 */
export async function deductFromBalance(
  userId: string,
  pointsUsed: number,
  subscription?: SubscriptionTier,
): Promise<DeductBalanceResult> {
  // No-op: nothing to deduct, balance unchanged (actual balance not fetched to avoid extra call)
  if (pointsUsed <= 0) {
    return {
      success: true,
      newBalanceDollars: 0,
      insufficientFunds: false,
      monthlyCapExceeded: false,
      noOp: true,
    };
  }

  try {
    const convex = getConvexClient();

    // Use the Convex action that handles deduction + auto-reload internally
    // Pass points directly to avoid precision loss from dollar conversion
    const result = await convex.action(
      api.extraUsageActions.deductWithAutoReload,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        userId,
        amountPoints: pointsUsed,
        ...(subscription ? { subscription } : {}),
      },
    );

    return {
      success: result.success,
      newBalanceDollars: result.newBalanceDollars,
      insufficientFunds: result.insufficientFunds,
      monthlyCapExceeded: result.monthlyCapExceeded,
      trustCapExceeded: result.trustCapExceeded,
      trustCapDollars: result.trustCapDollars,
      autoReloadTriggered: result.autoReloadTriggered,
      autoReloadResult: result.autoReloadResult,
    };
  } catch (error) {
    console.error("Error deducting from balance:", error);
    // Do NOT report as insufficientFunds — this was a service error, not an
    // empty balance. Returning insufficientFunds: false lets the caller
    // distinguish transient failures from actual balance exhaustion.
    return {
      success: false,
      newBalanceDollars: 0,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    };
  }
}

// =============================================================================
// Team-pool variants
// Same shape as the per-user functions above but org-scoped: balance lives on
// the org and per-member caps are enforced inside the Convex mutation.
// =============================================================================

export interface TeamExtraUsageState {
  enabled: boolean;
  balanceDollars: number;
  balancePoints: number;
  autoReloadEnabled: boolean;
  memberDisabled: boolean;
}

/**
 * Get the org's team-pool state plus this member's disabled flag.
 * Used by the rate limiter to build the ExtraUsageConfig for team users.
 */
export async function getTeamExtraUsageState(
  organizationId: string,
  userId: string,
): Promise<TeamExtraUsageState | null> {
  try {
    const convex = getConvexClient();
    const state = await convex.query(
      api.teamExtraUsage.getTeamExtraUsageStateForBackend,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        organizationId,
        userId,
      },
    );
    return {
      enabled: state.enabled,
      balanceDollars: state.balanceDollars,
      balancePoints: state.balancePoints,
      autoReloadEnabled: state.autoReloadEnabled,
      memberDisabled: state.memberDisabled,
    };
  } catch (error) {
    console.error("Error getting team extra usage state:", error);
    return null;
  }
}

/**
 * Deduct from team balance for a specific member. Enforces per-member cap,
 * member-disabled flag, team-wide cap, trust cap. Triggers auto-reload on
 * the org's Stripe customer when applicable.
 */
export async function deductFromTeamBalance(
  organizationId: string,
  userId: string,
  pointsUsed: number,
): Promise<DeductBalanceResult> {
  if (pointsUsed <= 0) {
    return {
      success: true,
      newBalanceDollars: 0,
      insufficientFunds: false,
      monthlyCapExceeded: false,
      noOp: true,
    };
  }

  try {
    const convex = getConvexClient();
    const result = await convex.action(
      api.teamExtraUsageActions.deductWithAutoReloadForTeam,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        organizationId,
        userId,
        amountPoints: pointsUsed,
      },
    );

    return {
      success: result.success,
      newBalanceDollars: result.newBalanceDollars,
      insufficientFunds: result.insufficientFunds,
      monthlyCapExceeded: result.monthlyCapExceeded,
      trustCapExceeded: result.trustCapExceeded,
      trustCapDollars: result.trustCapDollars,
      autoReloadTriggered: result.autoReloadTriggered,
      autoReloadResult: result.autoReloadResult,
      memberCapExceeded: result.memberCapExceeded,
      memberDisabled: result.memberDisabled,
      poolDisabled: result.poolDisabled,
    };
  } catch (error) {
    console.error("Error deducting from team balance:", error);
    return {
      success: false,
      newBalanceDollars: 0,
      insufficientFunds: false,
      monthlyCapExceeded: false,
    };
  }
}

/**
 * Refund points to team balance (for failed requests). Also decrements
 * the member's monthly_spent so they can spend again later.
 */
export async function refundToTeamBalance(
  organizationId: string,
  userId: string,
  pointsToRefund: number,
): Promise<RefundBalanceResult> {
  if (pointsToRefund <= 0) {
    return {
      success: true,
      newBalanceDollars: 0,
      noOp: true,
    };
  }

  try {
    const convex = getConvexClient();
    const result = await convex.mutation(api.teamExtraUsage.refundTeamPoints, {
      serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
      organizationId,
      userId,
      amountPoints: pointsToRefund,
    });
    return {
      success: result.success,
      newBalanceDollars: result.newBalanceDollars,
    };
  } catch (error) {
    console.error("Error refunding to team balance:", error);
    return {
      success: false,
      newBalanceDollars: 0,
    };
  }
}
