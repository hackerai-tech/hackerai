import {
  EXTRA_USAGE_MULTIPLIER,
  extraUsagePointsToDollars,
} from "@/convex/lib/extraUsagePricing";
import { getConvexClient } from "@/lib/db/convex-client";
import { api } from "@/convex/_generated/api";
import { phLogger } from "@/lib/posthog/server";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";

export { EXTRA_USAGE_MULTIPLIER };

const errorName = (error: unknown) =>
  error instanceof Error ? error.name : "UnknownError";

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_ABORTED",
  "ABORT_ERR",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** Fetch hides network failures in cause/AggregateError. Inspect at most 16
 * nodes in total and emit only known codes, never nested messages or addresses. */
function networkErrorCodes(error: unknown): string[] | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const codes = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const value = pending[index];
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    try {
      const entry = value as Record<string, unknown>;
      const code = entry.code;
      if (typeof code === "string" && NETWORK_ERROR_CODES.has(code)) {
        codes.add(code);
      }
      if (pending.length < 16) {
        const cause = entry.cause;
        if (cause != null) pending.push(cause);
      }
      if (pending.length < 16) {
        const errors = entry.errors;
        if (Array.isArray(errors)) {
          for (
            let child = 0;
            child < errors.length && pending.length < 16;
            child++
          ) {
            pending.push(errors[child]);
          }
        }
      }
    } catch {
      // Best-effort telemetry must not replace the original billing failure.
    }
  }
  return codes.size ? [...codes].sort() : undefined;
}

const logExtraUsageConvexFailure = ({
  event,
  message,
  userId,
  organizationId,
  amountPoints,
  usageSettlementId,
  convexFunction,
  operation,
  startedAt,
  error,
}: {
  event: string;
  message: string;
  userId?: string;
  organizationId?: string;
  amountPoints?: number;
  usageSettlementId?: string;
  convexFunction: string;
  operation: string;
  startedAt: number;
  error: unknown;
}) => {
  phLogger.error(message, {
    event,
    userId,
    organization_id: organizationId,
    amount_points: amountPoints,
    usage_settlement_id: usageSettlementId,
    convex_function: convexFunction,
    operation,
    component: "extra_usage",
    duration_ms: Date.now() - startedAt,
    // phLogger reserves error_name/error_message for the captured summary.
    convex_error_name: stringifyRedactedError(errorName(error)).slice(0, 128),
    convex_error_message: stringifyRedactedError(error).slice(0, 2_000),
    convex_network_error_codes: networkErrorCodes(error),
  });
};

export interface ExtraUsageBalance {
  balanceDollars: number;
  balancePoints: number;
  enabled: boolean;
  autoReloadEnabled: boolean;
  autoReloadThresholdDollars?: number;
  autoReloadThresholdPoints?: number;
  autoReloadAmountDollars?: number;
  monthlyCapDollars?: number;
  monthlySpentDollars?: number;
  monthlyRemainingDollars?: number;
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
  return extraUsagePointsToDollars(points);
}

/**
 * Get user's extra usage balance and settings.
 * Used by the rate limit logic to check if user can use extra usage.
 */
export async function getExtraUsageBalance(
  userId: string,
): Promise<ExtraUsageBalance | null> {
  const startedAt = Date.now();
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
      monthlyCapDollars: settings.monthlyCapDollars,
      monthlySpentDollars: settings.monthlySpentDollars,
      monthlyRemainingDollars: settings.monthlyRemainingDollars,
    };
  } catch (error) {
    logExtraUsageConvexFailure({
      event: "extra_usage_balance_fetch_failed",
      message: "Extra usage balance fetch failed",
      userId,
      convexFunction: "extraUsage.getExtraUsageBalanceForBackend",
      operation: "get_extra_usage_balance",
      startedAt,
      error,
    });
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

  const startedAt = Date.now();
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
    logExtraUsageConvexFailure({
      event: "extra_usage_refund_failed",
      message: "Extra usage refund failed",
      userId,
      amountPoints: pointsToRefund,
      convexFunction: "extraUsage.refundPoints",
      operation: "refund_extra_usage_balance",
      startedAt,
      error,
    });
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
 */
export async function deductFromBalance(
  userId: string,
  pointsUsed: number,
  usageSettlementId?: string,
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

  const startedAt = Date.now();
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
        usageSettlementId,
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
    logExtraUsageConvexFailure({
      event: "extra_usage_deduction_failed",
      message: "Extra usage deduction failed",
      userId,
      amountPoints: pointsUsed,
      usageSettlementId,
      convexFunction: "extraUsageActions.deductWithAutoReload",
      operation: "deduct_extra_usage_balance",
      startedAt,
      error,
    });
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
  monthlyCapDollars?: number;
  monthlySpentDollars?: number;
  memberMonthlyLimitDollars?: number;
  memberMonthlySpentDollars?: number;
  monthlyRemainingDollars?: number;
}

/**
 * Get the org's team-pool state plus this member's disabled flag.
 * Used by the rate limiter to build the ExtraUsageConfig for team users.
 */
export async function getTeamExtraUsageState(
  organizationId: string,
  userId: string,
): Promise<TeamExtraUsageState | null> {
  const startedAt = Date.now();
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
      monthlyCapDollars: state.monthlyCapDollars,
      monthlySpentDollars: state.monthlySpentDollars,
      memberMonthlyLimitDollars: state.memberMonthlyLimitDollars,
      memberMonthlySpentDollars: state.memberMonthlySpentDollars,
      monthlyRemainingDollars: state.monthlyRemainingDollars,
    };
  } catch (error) {
    logExtraUsageConvexFailure({
      event: "team_extra_usage_state_fetch_failed",
      message: "Team extra usage state fetch failed",
      userId,
      organizationId,
      convexFunction: "teamExtraUsage.getTeamExtraUsageStateForBackend",
      operation: "get_team_extra_usage_state",
      startedAt,
      error,
    });
    return null;
  }
}

/**
 * Deduct from team balance for a specific member. Enforces per-member cap,
 * member-disabled flag, and team-wide cap. Triggers auto-reload on the org's
 * Stripe customer when applicable.
 */
export async function deductFromTeamBalance(
  organizationId: string,
  userId: string,
  pointsUsed: number,
  usageSettlementId?: string,
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

  const startedAt = Date.now();
  try {
    const convex = getConvexClient();
    const result = await convex.action(
      api.teamExtraUsageActions.deductWithAutoReloadForTeam,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        organizationId,
        userId,
        amountPoints: pointsUsed,
        usageSettlementId,
      },
    );

    return {
      success: result.success,
      newBalanceDollars: result.newBalanceDollars,
      insufficientFunds: result.insufficientFunds,
      monthlyCapExceeded: result.monthlyCapExceeded,
      autoReloadTriggered: result.autoReloadTriggered,
      autoReloadResult: result.autoReloadResult,
      memberCapExceeded: result.memberCapExceeded,
      memberDisabled: result.memberDisabled,
      poolDisabled: result.poolDisabled,
    };
  } catch (error) {
    logExtraUsageConvexFailure({
      event: "team_extra_usage_deduction_failed",
      message: "Team extra usage deduction failed",
      userId,
      organizationId,
      amountPoints: pointsUsed,
      usageSettlementId,
      convexFunction: "teamExtraUsageActions.deductWithAutoReloadForTeam",
      operation: "deduct_team_extra_usage_balance",
      startedAt,
      error,
    });
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

  const startedAt = Date.now();
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
    logExtraUsageConvexFailure({
      event: "team_extra_usage_refund_failed",
      message: "Team extra usage refund failed",
      userId,
      organizationId,
      amountPoints: pointsToRefund,
      convexFunction: "teamExtraUsage.refundTeamPoints",
      operation: "refund_team_extra_usage_balance",
      startedAt,
      error,
    });
    return {
      success: false,
      newBalanceDollars: 0,
    };
  }
}
