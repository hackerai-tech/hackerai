import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import type { ChatMode, SubscriptionTier } from "@/types";
import type { LimitCapReason } from "@/lib/limit-pressure";
import {
  AGENT_RUN_SPEND_CAP_REASON,
  type AgentRunSpendCapBasis,
} from "@/lib/chat/agent-run-spend-cap";
import {
  getExtraUsageLimitCta,
  getLimitTypeForCapReason,
  shouldShowUpgradeCta,
} from "@/lib/limit-pressure";
import {
  captureAddCreditCtaClick,
  captureAddCreditCtaImpression,
  captureAgentRunSpendCapImpression,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";

// Discriminated union for warning data
export type RateLimitWarningData =
  | {
      warningType: "sliding-window";
      remaining: number;
      resetTime: Date;
      mode: ChatMode;
      subscription: SubscriptionTier;
    }
  | {
      warningType: "token-bucket";
      bucketType: "monthly";
      remainingPercent: number;
      resetTime: Date;
      subscription: SubscriptionTier;
      severity?: "info" | "warning";
      usedDollars?: number;
      limitDollars?: number;
      capReason?: LimitCapReason;
      midStream?: boolean;
      cutOff?: boolean;
    }
  | {
      warningType: "extra-usage-active";
      bucketType: "monthly";
      resetTime: Date;
      subscription: SubscriptionTier;
      capReason?: LimitCapReason;
      midStream?: boolean;
    }
  | {
      warningType: "agent-run-spend-cap";
      resetTime: Date;
      subscription: "pro";
      mode: "agent";
      runCostDollars: number;
      runCapDollars: number;
      monthlyRemainingDollars: number;
      capBasis: AgentRunSpendCapBasis;
      premiumContinuationAllowed: boolean;
      midStream?: boolean;
    };

interface RateLimitWarningProps {
  data: RateLimitWarningData;
  onDismiss: () => void;
}

const formatTimeUntil = (resetTime: Date): string => {
  const now = new Date();
  const timeDiff = resetTime.getTime() - now.getTime();

  if (timeDiff <= 0) {
    return "now";
  }

  const daysUntil = Math.floor(timeDiff / (1000 * 60 * 60 * 24));
  const hoursUntil = Math.floor(
    (timeDiff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
  );
  const minutesUntil = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

  if (daysUntil === 0 && hoursUntil === 0 && minutesUntil === 0) {
    return "in less than a minute";
  }
  if (daysUntil >= 1 && hoursUntil === 0) {
    return `in ${daysUntil} ${daysUntil === 1 ? "day" : "days"}`;
  }
  if (daysUntil >= 1) {
    return `in ${daysUntil}d ${hoursUntil}h`;
  }
  if (hoursUntil === 0) {
    return `in ${minutesUntil} ${minutesUntil === 1 ? "minute" : "minutes"}`;
  }
  if (minutesUntil === 0) {
    return `in ${hoursUntil} ${hoursUntil === 1 ? "hour" : "hours"}`;
  }
  return `in ${hoursUntil}h ${minutesUntil}m`;
};

const getMessage = (data: RateLimitWarningData, timeString: string): string => {
  if (data.warningType === "sliding-window") {
    if (data.remaining === 0) {
      return data.mode === "agent"
        ? "You've used today's free Agent requests. Upgrade to keep running Agent today, or wait for the reset at midnight UTC."
        : "You've used all your daily free requests. Upgrade to keep going today, or wait for the reset at midnight UTC.";
    }

    return `You have ${data.remaining} daily ${data.remaining === 1 ? "request" : "requests"} remaining today.`;
  }

  if (data.warningType === "extra-usage-active") {
    return `You're now using extra usage credits. Your monthly limit resets ${timeString}.`;
  }

  if (data.warningType === "agent-run-spend-cap") {
    return `This Pro Agent run paused after using $${data.runCostDollars.toFixed(2)} of the $${data.runCapDollars.toFixed(2)} legacy per-run safety cap. Continue to keep working.`;
  }

  // Token bucket warning — show dollar amounts when available
  if (data.remainingPercent === 0) {
    if (data.cutOff) {
      if (data.subscription === "free") {
        return `You've reached your free monthly usage limit and this response was cut off. Upgrade for higher limits. Resets ${timeString}.`;
      }
      if (data.capReason === "extra_usage_cap") {
        return `You've reached your extra usage spending limit and this response was cut off. Increase your limit to continue. Resets ${timeString}.`;
      }
      if (data.capReason === "paid_daily_free_allowance_cut_off") {
        return `Today's free Ask allowance was used up and this response was cut off. Add credits to continue. Resets ${timeString}.`;
      }
      return `You've reached your monthly limit and this response was cut off. Add credits or upgrade to continue. Resets ${timeString}.`;
    }
    if (data.subscription === "free") {
      return `You've reached your free monthly usage limit. Upgrade for higher limits. Resets ${timeString}.`;
    }

    return `You've reached your monthly usage limit. It resets ${timeString}.`;
  }

  const usedPercent = 100 - data.remainingPercent;
  if (data.usedDollars !== undefined && data.limitDollars !== undefined) {
    return `You've used $${data.usedDollars.toFixed(2)} of $${data.limitDollars.toFixed(2)} (${usedPercent}%). Resets ${timeString}.`;
  }

  return `You have ${data.remainingPercent}% of your monthly usage remaining. It resets ${timeString}.`;
};

const getUpgradeCtaText = (
  data: RateLimitWarningData,
  limitType: string,
): string => {
  if (
    data.subscription === "free" &&
    (limitType === "daily_requests" || limitType === "free_monthly")
  ) {
    return "Keep going";
  }

  return "Upgrade plan";
};

const WARNING_STYLES = "bg-input-chat border-black/8 dark:border-border";

export const RateLimitWarning = ({
  data,
  onDismiss,
}: RateLimitWarningProps) => {
  const capturedUpgradeImpressionRef = useRef(false);
  const capturedAddCreditImpressionRef = useRef(false);
  const capturedAgentRunCapImpressionRef = useRef(false);
  const timeString = formatTimeUntil(data.resetTime);
  const message = getMessage(data, timeString);
  const capReason =
    data.warningType === "sliding-window" ||
    data.warningType === "agent-run-spend-cap"
      ? undefined
      : data.capReason;
  const extraUsageCta =
    data.warningType === "token-bucket"
      ? getExtraUsageLimitCta({
          subscription: data.subscription,
          capReason,
        })
      : null;
  const showUsageCta = data.warningType === "extra-usage-active";
  const showUpgrade =
    data.warningType !== "agent-run-spend-cap" &&
    data.warningType !== "extra-usage-active" &&
    shouldShowUpgradeCta({
      subscription: data.subscription,
      capReason,
    });
  const limitType =
    data.warningType === "sliding-window"
      ? "daily_requests"
      : data.warningType === "agent-run-spend-cap"
        ? "monthly"
        : data.warningType === "token-bucket"
          ? getLimitTypeForCapReason(capReason)
          : getLimitTypeForCapReason(data.capReason ?? "extra_usage_active");
  const limitSeverity =
    data.warningType === "token-bucket" && data.remainingPercent === 0
      ? "hit"
      : "warning";
  const upgradeCtaText = getUpgradeCtaText(data, limitType);

  useEffect(() => {
    if (data.warningType !== "agent-run-spend-cap") return;
    if (capturedAgentRunCapImpressionRef.current) return;
    capturedAgentRunCapImpressionRef.current = true;
    captureAgentRunSpendCapImpression({
      surface: "rate_limit_warning",
      source: AGENT_RUN_SPEND_CAP_REASON,
      subscription_tier: data.subscription,
      mode: data.mode,
      cap_reason: AGENT_RUN_SPEND_CAP_REASON,
      run_cost_dollars: data.runCostDollars,
      run_cap_dollars: data.runCapDollars,
      monthly_remaining_dollars: data.monthlyRemainingDollars,
      cap_basis: data.capBasis,
      premium_continuation_allowed: data.premiumContinuationAllowed,
    });
  }, [data]);

  useEffect(() => {
    if (!showUpgrade || capturedUpgradeImpressionRef.current) return;
    capturedUpgradeImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: "rate_limit_warning",
      source: "limit_pressure",
      from_tier: data.subscription,
      limit_type: limitType,
      limit_severity: limitSeverity,
      cap_reason: capReason,
      cta_text: upgradeCtaText,
    });
  }, [
    capReason,
    data.subscription,
    limitSeverity,
    limitType,
    showUpgrade,
    upgradeCtaText,
  ]);

  useEffect(() => {
    if (!extraUsageCta || capturedAddCreditImpressionRef.current) return;
    capturedAddCreditImpressionRef.current = true;
    captureAddCreditCtaImpression({
      surface: "rate_limit_warning",
      source: "limit_pressure",
      from_tier: data.subscription,
      limit_type: limitType,
      limit_severity: limitSeverity,
      cap_reason: capReason,
      cta_text: extraUsageCta.analyticsText,
    });
  }, [capReason, data.subscription, extraUsageCta, limitSeverity, limitType]);

  return (
    <div
      data-testid="rate-limit-warning"
      className={`mb-2 px-3 py-2.5 border rounded-[22px] flex items-center justify-between gap-2 ${WARNING_STYLES}`}
    >
      <div className="flex-1 flex items-center gap-2 flex-wrap">
        <span className="text-foreground text-sm">{message}</span>
        {extraUsageCta && (
          <Button
            onClick={() => {
              captureAddCreditCtaClick({
                surface: "rate_limit_warning",
                source: "limit_pressure",
                from_tier: data.subscription,
                limit_type: limitType,
                limit_severity: limitSeverity,
                cap_reason: capReason,
                cta_text: extraUsageCta.analyticsText,
              });
              openSettingsDialog(extraUsageCta.settingsTab);
            }}
            size="sm"
            variant={
              extraUsageCta.analyticsText === "Add Credits"
                ? "default"
                : "outline"
            }
            className="h-7 px-3 text-xs font-medium border-black/8 dark:border-border"
          >
            {extraUsageCta.label}
          </Button>
        )}
        {showUsageCta && (
          <Button
            onClick={() => openSettingsDialog("Usage")}
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs font-medium border-black/8 dark:border-border"
          >
            View Usage
          </Button>
        )}
        {showUpgrade && (
          <Button
            onClick={() =>
              redirectToPricing({
                surface: "rate_limit_warning",
                source: "limit_pressure",
                from_tier: data.subscription,
                limit_type: limitType,
                reason: capReason,
                cta_text: upgradeCtaText,
              })
            }
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs font-medium border-black/8 dark:border-border"
          >
            {upgradeCtaText}
          </Button>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
        aria-label="Dismiss warning"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
};
