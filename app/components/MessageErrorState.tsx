import { useState, useEffect, useMemo, useRef } from "react";
import { useAction, useQuery } from "convex/react";
import { Button } from "@/components/ui/button";
import {
  BuyExtraUsageDialog,
  getApproximateWeeklyExtraUsageSpend,
  getRecommendedExtraUsagePurchaseAmount,
} from "@/app/components/extra-usage/BuyExtraUsageDialog";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
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
  captureAuthenticatedEvent,
  newCheckoutAttemptId,
  capturePaidDailyFreeAllowanceClick,
  capturePaidDailyFreeAllowanceImpression,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import type { ChatMode } from "@/types";
import type { LimitCapReason } from "@/lib/limit-pressure";
import {
  getPaidDailyFreeAllowanceCtaText,
  getExtraUsageLimitCta,
  getLimitTypeForCapReason,
  shouldShowUpgradeCta,
} from "@/lib/limit-pressure";
import type { RetryOptions } from "../hooks/useChatHandlers";
import { formatTaskUiCopy } from "@/app/utils/task-ui-copy";

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

const getCurrentReturnPath = (): string => {
  const fullPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (fullPath.length <= 400) return fullPath;
  return window.location.pathname.length <= 400
    ? window.location.pathname
    : "/";
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
  const [showBuyDialog, setShowBuyDialog] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isUpdatingPayment, setIsUpdatingPayment] = useState(false);
  const createPurchaseSession = useAction(
    api.extraUsageActions.createPurchaseSession,
  );
  const createBillingPortalSession = useAction(
    api.extraUsageActions.createBillingPortalSession,
  );
  const extraUsageSettings = useQuery(
    api.extraUsage.getExtraUsageSettings,
    showBuyDialog ? {} : "skip",
  );

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
  const errorMessage = formatTaskUiCopy(
    (() => {
      if (displayError instanceof ChatSDKError) {
        return typeof displayError.cause === "string"
          ? displayError.cause
          : displayError.message;
      }
      return displayError.message || "An error occurred.";
    })(),
  );
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
  const isConcurrencyLimit = limitType === "concurrency";
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
  const showRateLimitUsage =
    !shouldFocusPaidAllowanceActions && !isConcurrencyLimit;
  const showUpgrade = canUpgrade && !shouldFocusPaidAllowanceActions;
  const isDirectAddCredits = extraUsageCta?.analyticsText === "Add Credits";
  const isPaymentRecovery = capReason === "auto_reload_failed";
  const extraUsageCtaText = isDirectAddCredits
    ? "Add $15 and continue"
    : isPaymentRecovery
      ? "Update card and retry"
      : extraUsageCta?.label;
  const recommendedPurchaseAmountDollars =
    getRecommendedExtraUsagePurchaseAmount(
      getApproximateWeeklyExtraUsageSpend(
        extraUsageSettings?.monthlySpentDollars,
      ),
    );

  useEffect(() => {
    const url = new URL(window.location.href);
    const shouldResume =
      url.searchParams.get("extra-usage-resume") === "true" ||
      url.searchParams.get("extra-usage-payment-retry") === "true";

    if (!shouldResume) return;

    url.searchParams.delete("extra-usage-resume");
    url.searchParams.delete("extra-usage-payment-retry");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
    onRetry();
  }, [onRetry]);

  const handlePurchaseCredits = async (amountDollars: number) => {
    setIsPurchasing(true);
    try {
      const checkoutAttemptId = newCheckoutAttemptId();
      const result = await createPurchaseSession({
        amountDollars,
        baseUrl: window.location.origin,
        checkoutAttemptId,
        returnPath: getCurrentReturnPath(),
        resumeAfterPurchase: true,
        enableExtraUsageAfterPurchase: true,
      });

      if (!result.url) {
        toast.error(result.error || "Failed to create checkout session");
        return;
      }

      captureAuthenticatedEvent(
        PAID_FUNNEL_EVENTS.addCreditCheckoutStarted,
        paidFunnelProperties({
          checkout_attempt_id: checkoutAttemptId,
          checkout_type: "extra_usage_purchase",
          surface: "message_error_state",
          source: "rate_limit_error",
          amount_dollars: amountDollars,
          stripe_checkout_session_id: result.checkoutSessionId,
        }),
      );
      window.location.href = result.url;
    } catch (error) {
      console.error("Failed to purchase credits:", error);
      toast.error("Failed to purchase credits");
    } finally {
      setIsPurchasing(false);
    }
  };

  const handleUpdatePaymentMethod = async () => {
    setIsUpdatingPayment(true);
    try {
      const returnUrl = new URL(window.location.href);
      returnUrl.searchParams.set("extra-usage-payment-retry", "true");
      const result = await createBillingPortalSession({
        flow: "payment_method",
        baseUrl: returnUrl.toString(),
      });

      if (!result.url) {
        toast.error(result.error || "Failed to open billing portal");
        return;
      }

      window.location.href = result.url;
    } catch (error) {
      console.error("Failed to update payment method:", error);
      toast.error("Failed to open billing portal");
    } finally {
      setIsUpdatingPayment(false);
    }
  };

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
      cta_text: extraUsageCtaText ?? extraUsageCta.analyticsText,
    });
  }, [
    capReason,
    extraUsageCta,
    extraUsageCtaText,
    isPaidUser,
    isRateLimitError,
    subscription,
  ]);

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
                variant={isDirectAddCredits ? "default" : "outline"}
                size="sm"
                disabled={isPurchasing || isUpdatingPayment}
                onClick={() => {
                  captureAddCreditCtaClick({
                    surface: "message_error_state",
                    source: "rate_limit_error",
                    from_tier: subscription,
                    cap_reason: capReason,
                    cta_text: extraUsageCtaText ?? extraUsageCta.analyticsText,
                  });
                  if (isDirectAddCredits) {
                    setShowBuyDialog(true);
                  } else if (isPaymentRecovery) {
                    void handleUpdatePaymentMethod();
                  } else {
                    openSettingsDialog(extraUsageCta.settingsTab);
                  }
                }}
              >
                {isUpdatingPayment ? "Opening billing..." : extraUsageCtaText}
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
            New Task
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
      <BuyExtraUsageDialog
        open={showBuyDialog}
        onOpenChange={setShowBuyDialog}
        onPurchase={handlePurchaseCredits}
        isLoading={isPurchasing}
        recommendedAmountDollars={recommendedPurchaseAmountDollars}
        title="Add credits and continue"
        description="Choose how much extra usage to add. Your stopped task will retry after payment succeeds."
      />
    </div>
  );
};
