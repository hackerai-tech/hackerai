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

export const PAID_DAILY_FREE_ALLOWANCE_MODEL = "ask-model-free";

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
  endpoint: "/api/chat";
  reservation?: PaidDailyFreeAllowanceReservation;
  extra?: Record<string, unknown>;
}) {
  const status = reservation?.status;
  phLogger.event(
    event,
    paidFunnelProperties({
      userId,
      subscription_tier: subscription,
      mode,
      chat_id: chatId,
      endpoint,
      limit_rescue_type: "paid_daily_free_allowance",
      paid_daily_free_allowance_request_limit: status?.requestLimit,
      paid_daily_free_allowance_requests_remaining: status?.requestsRemaining,
      paid_daily_free_allowance_cost_limit_dollars: status?.costLimitDollars,
      paid_daily_free_allowance_cost_remaining_dollars:
        status?.costRemainingDollars,
      paid_daily_free_allowance_reset_timestamp: status?.resetTimestamp,
      paid_daily_free_allowance_unavailable_reason:
        status?.unavailableReason ?? reservation?.blockReason,
      ...extra,
      $set: {
        subscription_tier: subscription,
      },
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
    requestLimit: reservation.status.requestLimit,
    costLimitDollars: reservation.status.costLimitDollars,
    resetTimestamp: reservation.status.resetTimestamp,
  };
}
