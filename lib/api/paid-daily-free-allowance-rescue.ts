import "server-only";

import type { BudgetSnapshot } from "@/lib/chat/budget-monitor";
import type { ChatSDKError } from "@/lib/errors";
import type { LimitCapReason } from "@/lib/limit-pressure";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { phLogger } from "@/lib/posthog/server";
import type { PaidDailyFreeAllowanceReservation } from "@/lib/rate-limit";
import type { ChatMode, RateLimitInfo, SubscriptionTier } from "@/types";
import type { ChatApiEndpoint } from "@/lib/api/agent-endpoints";

export function getPaidDailyFreeAllowanceModel(mode: ChatMode) {
  return mode === "agent" ? "model-deepseek-v4-flash-0731" : "ask-model-free";
}

type PaidDailyFreeAllowanceEvent =
  | typeof PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceStarted
  | typeof PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceSucceeded
  | typeof PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceBlocked
  | typeof PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceCutOff;

export function getRateLimitErrorCapReason(
  error: ChatSDKError,
): LimitCapReason | undefined {
  return typeof error.metadata?.capReason === "string"
    ? error.metadata.capReason
    : undefined;
}

export function createPaidDailyFreeAllowanceRateLimitInfo(
  reservation: PaidDailyFreeAllowanceReservation,
): RateLimitInfo {
  return {
    remaining: 0,
    resetTime: reservation.status.resetTime,
    limit: 0,
    ...(reservation.status.rateLimitSkipped && { rateLimitSkipped: true }),
  };
}

export function createPaidDailyFreeAllowanceBudgetSnapshot(
  reservation: PaidDailyFreeAllowanceReservation,
): BudgetSnapshot | null {
  if (reservation.status.rateLimitSkipped) return null;

  return {
    monthlyLimitPoints: reservation.status.costLimitPoints,
    monthlyRemainingAtStart: reservation.status.costRemainingPoints,
    monthlyResetTime: reservation.status.resetTime,
    extraUsageEnabledAtStart: false,
    extraUsageHasBalanceAtStart: false,
    extraUsageBalanceAtStart: 0,
    extraUsageAutoReload: false,
    extraUsageOverflowAllowed: false,
    capReasonOnExhaustion: "paid_daily_free_allowance_cut_off",
  };
}

export function capturePaidDailyFreeAllowanceServerEvent({
  event,
  userId,
  subscription,
  mode,
  chatId,
  endpoint,
  reservation,
  extra,
}: {
  event: PaidDailyFreeAllowanceEvent;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  chatId: string;
  endpoint: ChatApiEndpoint;
  reservation?: PaidDailyFreeAllowanceReservation;
  extra?: Record<string, unknown>;
}) {
  const status = reservation?.status;
  const now = new Date().toISOString();
  // Person properties let PostHog split exhausted users into "used the
  // allowance" vs "did not" for retention, cancellation, and top-up
  // comparisons without a join.
  const isRescueStart =
    event === PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceStarted;
  const isRescueEnd =
    event === PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceSucceeded ||
    event === PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceCutOff;
  phLogger.event(
    event,
    paidFunnelProperties({
      userId,
      subscription_tier: subscription,
      mode,
      chat_id: chatId,
      endpoint,
      limit_rescue_type: "paid_daily_free_allowance",
      paid_daily_free_allowance_requests_today: status?.requestsUsed,
      paid_daily_free_allowance_cost_limit_dollars: status?.costLimitDollars,
      paid_daily_free_allowance_cost_used_today_dollars:
        status?.costUsedDollars,
      paid_daily_free_allowance_cost_remaining_dollars:
        status?.costRemainingDollars,
      paid_daily_free_allowance_reset_timestamp: status?.resetTimestamp,
      paid_daily_free_allowance_unavailable_reason:
        status?.unavailableReason ?? reservation?.blockReason,
      ...extra,
      $set: {
        subscription_tier: subscription,
        ...(isRescueStart && {
          paid_daily_free_allowance_last_used_at: now,
          paid_daily_free_allowance_last_used_mode: mode,
        }),
        ...(isRescueEnd && {
          paid_daily_free_allowance_last_completed_at: now,
          paid_daily_free_allowance_last_cut_off:
            event === PAID_FUNNEL_EVENTS.paidDailyFreeAllowanceCutOff,
        }),
      },
      ...(isRescueStart && {
        $set_once: {
          paid_daily_free_allowance_first_used_at: now,
          paid_daily_free_allowance_first_used_mode: mode,
          paid_daily_free_allowance_first_used_tier: subscription,
        },
      }),
    }),
  );
}

export function createPaidDailyFreeAllowanceUsageLogContext(
  reservation: PaidDailyFreeAllowanceReservation,
  cutOff: boolean,
) {
  return {
    active: true,
    cutOff,
    requestsToday: reservation.status.requestsUsed,
    costLimitDollars: reservation.status.costLimitDollars,
    resetTimestamp: reservation.status.resetTimestamp,
  };
}
