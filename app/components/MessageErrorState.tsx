import { useState, useEffect, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import {
  ChatSDKError,
  deserializeChatSDKErrorFromStream,
  isNetworkStreamError,
} from "@/lib/errors";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import {
  captureAddCreditCtaClick,
  captureAddCreditCtaImpression,
  capturePaidDailyFreeAllowanceClick,
  capturePaidDailyFreeAllowanceImpression,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";
import type { ChatMode } from "@/types";
import type { LimitCapReason } from "@/lib/limit-pressure";
import {
  getPaidDailyFreeAllowanceCtaText,
  getExtraUsageLimitCta,
  getLimitTypeForCapReason,
  shouldShowUpgradeCta,
} from "@/lib/limit-pressure";
import type { RetryOptions } from "../hooks/useChatHandlers";

interface MessageErrorStateProps {
  error: Error;
  onRetry: (options?: RetryOptions) => void;
  onReconnect?: () => void;
  mode?: ChatMode;
}

const formatCountdown = (ms: number): string => {
  if (ms <= 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
};

export const MessageErrorState = ({
  error,
  onRetry,
  onReconnect,
  mode,
}: MessageErrorStateProps) => {
  const { subscription, initializeNewChat } = useGlobalState();
  const structuredStreamError = useMemo(
    () => deserializeChatSDKErrorFromStream(error),
    [error],
  );
  const displayError = structuredStreamError ?? error;
  const isRateLimitError =
    displayError instanceof ChatSDKError && displayError.type === "rate_limit";

  const metadata =
    displayError instanceof ChatSDKError ? displayError.metadata : undefined;
  const resetTimestamp = metadata?.resetTimestamp as number | undefined;
  const capReason = metadata?.capReason as LimitCapReason | undefined;
  const upgradeImpressionRef = useRef(false);
  const addCreditImpressionRef = useRef(false);
  const paidDailyFreeAllowanceImpressionRef = useRef(false);

  const [timeRemaining, setTimeRemaining] = useState<number>(0);

  useEffect(() => {
    if (!resetTimestamp) return;

    const update = () =>
      setTimeRemaining(Math.max(0, resetTimestamp - Date.now()));
    update();
    const interval = setInterval(update, 1_000);
    return () => {
      clearInterval(interval);
      setTimeRemaining(0);
    };
  }, [resetTimestamp]);

  // Extract error message - check for cause first, then message
  const errorMessage = (() => {
    if (displayError instanceof ChatSDKError) {
      return typeof displayError.cause === "string"
        ? displayError.cause
        : displayError.message;
    }
    return displayError.message || "An error occurred.";
  })();
  const isProviderContentBlocked =
    metadata?.providerErrorCategory === "content_blocked" ||
    /provider blocked this request|flagged by its safety system|PROHIBITED_CONTENT|content[_ -]?filter|content[_ -]?policy/i.test(
      errorMessage,
    );
  const canReconnect =
    !isProviderContentBlocked &&
    !!onReconnect &&
    isNetworkStreamError(displayError);

  const isPaidUser = subscription !== "free";
  const canUpgrade = shouldShowUpgradeCta({ subscription, capReason });
  const extraUsageCta = getExtraUsageLimitCta({ subscription, capReason });
  const limitType = getLimitTypeForCapReason(capReason);
  const upgradeCtaText =
    subscription === "free" &&
    (limitType === "daily_requests" || limitType === "free_monthly")
      ? "Keep going"
      : "Upgrade Plan";
  const isSuspensionError = metadata?.suspensionCategory !== undefined;
  const paidDailyFreeAllowance =
    metadata?.paidDailyFreeAllowance &&
    typeof metadata.paidDailyFreeAllowance === "object"
      ? (metadata.paidDailyFreeAllowance as Record<string, unknown>)
      : undefined;
  const canUsePaidDailyFreeAllowance =
    isRateLimitError &&
    paidDailyFreeAllowance?.type === "paid_daily_free_allowance" &&
    paidDailyFreeAllowance.available === true;
  const paidDailyFreeAllowanceCtaText = getPaidDailyFreeAllowanceCtaText(mode);
  const allowanceCostRemaining =
    typeof paidDailyFreeAllowance?.costRemainingDollars === "number"
      ? paidDailyFreeAllowance.costRemainingDollars
      : undefined;
  const shouldFocusPaidAllowanceActions =
    canUsePaidDailyFreeAllowance &&
    extraUsageCta?.analyticsText === "Add Credits";
  const showRateLimitRetry = !shouldFocusPaidAllowanceActions;
  const showRateLimitUsage = !shouldFocusPaidAllowanceActions;
  const showUpgrade = canUpgrade && !shouldFocusPaidAllowanceActions;

  useEffect(() => {
    if (!isRateLimitError || !showUpgrade || upgradeImpressionRef.current)
      return;

    upgradeImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: "message_error_state",
      source: "rate_limit_error",
      from_tier: subscription,
      cap_reason: capReason,
      limit_type: limitType,
      cta_text: upgradeCtaText,
    });
  }, [
    capReason,
    isRateLimitError,
    limitType,
    showUpgrade,
    subscription,
    upgradeCtaText,
  ]);

  useEffect(() => {
    if (
      !isRateLimitError ||
      !isPaidUser ||
      !extraUsageCta ||
      addCreditImpressionRef.current
    ) {
      return;
    }

    addCreditImpressionRef.current = true;
    captureAddCreditCtaImpression({
      surface: "message_error_state",
      source: "rate_limit_error",
      from_tier: subscription,
      cap_reason: capReason,
      cta_text: extraUsageCta.analyticsText,
    });
  }, [capReason, extraUsageCta, isPaidUser, isRateLimitError, subscription]);

  useEffect(() => {
    if (
      !canUsePaidDailyFreeAllowance ||
      paidDailyFreeAllowanceImpressionRef.current
    ) {
      return;
    }

    paidDailyFreeAllowanceImpressionRef.current = true;
    capturePaidDailyFreeAllowanceImpression({
      surface: "message_error_state",
      source: "rate_limit_error",
      from_tier: subscription,
      cap_reason: capReason,
      cta_text: paidDailyFreeAllowanceCtaText,
      allowance_requests_remaining: paidDailyFreeAllowance?.requestsRemaining,
      allowance_cost_remaining_dollars:
        paidDailyFreeAllowance?.costRemainingDollars,
    });
  }, [
    canUsePaidDailyFreeAllowance,
    capReason,
    paidDailyFreeAllowance,
    paidDailyFreeAllowanceCtaText,
    subscription,
  ]);

  return (
    <div
      className={
        isProviderContentBlocked
          ? "bg-amber-500/10 border border-amber-500/25 rounded-lg p-3"
          : "bg-destructive/10 border border-destructive/20 rounded-lg p-3"
      }
    >
      <div
        className={
          isProviderContentBlocked
            ? "text-foreground text-sm mb-2"
            : "text-destructive text-sm mb-2"
        }
      >
        {isRateLimitError ? (
          <MemoizedMarkdown content={errorMessage} />
        ) : isProviderContentBlocked ? (
          <>
            <p>{errorMessage}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Retrying with the same conversation usually fails again.
            </p>
          </>
        ) : (
          <p>{errorMessage}</p>
        )}
        {isRateLimitError && timeRemaining > 0 && (
          <p className="text-xs text-muted-foreground mt-1">
            Resets in {formatCountdown(timeRemaining)}
          </p>
        )}
        {canUsePaidDailyFreeAllowance && (
          <p className="text-xs text-muted-foreground mt-2">
            Your paid-plan limit is used up, but you still have
            {allowanceCostRemaining !== undefined
              ? ` up to $${allowanceCostRemaining.toFixed(2)}`
              : " some"}{" "}
            of free usage today. Continue this request in{" "}
            {mode === "agent"
              ? "Agent"
              : mode === "ask"
                ? "Ask"
                : "the current"}{" "}
            mode with our low-cost model. The daily allowance resets at midnight
            UTC.
          </p>
        )}
      </div>
      <div className="flex gap-2 flex-wrap">
        {isRateLimitError ? (
          <>
            {showRateLimitRetry && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onRetry()}
                disabled={timeRemaining > 0 && !isPaidUser}
              >
                {timeRemaining > 0 && !isPaidUser
                  ? `Try again in ${formatCountdown(timeRemaining)}`
                  : "Try Again"}
              </Button>
            )}
            {showRateLimitUsage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openSettingsDialog("Usage")}
              >
                View Usage
              </Button>
            )}
            {extraUsageCta && (
              <Button
                variant={
                  extraUsageCta.analyticsText === "Add Credits"
                    ? "default"
                    : "outline"
                }
                size="sm"
                onClick={() => {
                  captureAddCreditCtaClick({
                    surface: "message_error_state",
                    source: "rate_limit_error",
                    from_tier: subscription,
                    cap_reason: capReason,
                    cta_text: extraUsageCta.analyticsText,
                  });
                  openSettingsDialog(extraUsageCta.settingsTab);
                }}
              >
                {extraUsageCta.label}
              </Button>
            )}
            {canUsePaidDailyFreeAllowance && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  capturePaidDailyFreeAllowanceClick({
                    surface: "message_error_state",
                    source: "rate_limit_error",
                    from_tier: subscription,
                    cap_reason: capReason,
                    cta_text: paidDailyFreeAllowanceCtaText,
                    allowance_requests_remaining:
                      paidDailyFreeAllowance?.requestsRemaining,
                    allowance_cost_remaining_dollars:
                      paidDailyFreeAllowance?.costRemainingDollars,
                  });
                  onRetry({
                    limitRescue: { type: "paid_daily_free_allowance" },
                  });
                }}
              >
                {paidDailyFreeAllowanceCtaText}
              </Button>
            )}
            {showUpgrade && (
              <Button
                variant={
                  extraUsageCta?.analyticsText === "Add Credits"
                    ? "outline"
                    : "default"
                }
                size="sm"
                onClick={() =>
                  redirectToPricing({
                    surface: "message_error_state",
                    source: "rate_limit_error",
                    from_tier: subscription,
                    reason: capReason,
                    limit_type: limitType,
                    cta_text: upgradeCtaText,
                  })
                }
              >
                {upgradeCtaText}
              </Button>
            )}
          </>
        ) : isProviderContentBlocked ? (
          <Button variant="outline" size="sm" onClick={initializeNewChat}>
            New Chat
          </Button>
        ) : (
          <>
            {isSuspensionError ? (
              <Button
                variant="default"
                size="sm"
                onClick={() =>
                  window.open(
                    "https://help.hackerai.co/",
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                Contact Support
              </Button>
            ) : (
              <>
                {canReconnect && (
                  <Button variant="default" size="sm" onClick={onReconnect}>
                    Reconnect
                  </Button>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => onRetry()}
                >
                  Retry
                </Button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
