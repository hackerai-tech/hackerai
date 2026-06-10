import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { ChatSDKError, isNetworkStreamError } from "@/lib/errors";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import {
  captureAddCreditCtaClick,
  captureAddCreditCtaImpression,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";
import type { LimitCapReason } from "@/lib/limit-pressure";
import {
  getExtraUsageLimitCta,
  shouldShowUpgradeCta,
} from "@/lib/limit-pressure";

interface MessageErrorStateProps {
  error: Error;
  onRetry: () => void;
  onReconnect?: () => void;
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
}: MessageErrorStateProps) => {
  const { subscription, initializeNewChat } = useGlobalState();
  const isRateLimitError =
    error instanceof ChatSDKError && error.type === "rate_limit";

  const metadata = error instanceof ChatSDKError ? error.metadata : undefined;
  const resetTimestamp = metadata?.resetTimestamp as number | undefined;
  const capReason = metadata?.capReason as LimitCapReason | undefined;
  const upgradeImpressionRef = useRef(false);
  const addCreditImpressionRef = useRef(false);

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
    if (error instanceof ChatSDKError) {
      return typeof error.cause === "string" ? error.cause : error.message;
    }
    return error.message || "An error occurred.";
  })();
  const isProviderContentBlocked =
    metadata?.providerErrorCategory === "content_blocked" ||
    /provider blocked this request|flagged by its safety system|PROHIBITED_CONTENT|content[_ -]?filter|content[_ -]?policy/i.test(
      errorMessage,
    );
  const canReconnect =
    !isProviderContentBlocked && !!onReconnect && isNetworkStreamError(error);

  const isPaidUser = subscription !== "free";
  const canUpgrade = shouldShowUpgradeCta({ subscription, capReason });
  const extraUsageCta = getExtraUsageLimitCta({ subscription, capReason });
  const isSuspensionError = metadata?.suspensionCategory !== undefined;

  useEffect(() => {
    if (!isRateLimitError || !canUpgrade || upgradeImpressionRef.current)
      return;

    upgradeImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: "message_error_state",
      source: "rate_limit_error",
      from_tier: subscription,
      cap_reason: capReason,
      cta_text: "Upgrade Plan",
    });
  }, [canUpgrade, capReason, isRateLimitError, subscription]);

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
      </div>
      <div className="flex gap-2 flex-wrap">
        {isRateLimitError ? (
          <>
            <Button
              variant="destructive"
              size="sm"
              onClick={onRetry}
              disabled={timeRemaining > 0 && !isPaidUser}
            >
              {timeRemaining > 0 && !isPaidUser
                ? `Try again in ${formatCountdown(timeRemaining)}`
                : "Try Again"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openSettingsDialog("Usage")}
            >
              View Usage
            </Button>
            {extraUsageCta && (
              <Button
                variant="outline"
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
            {canUpgrade && (
              <Button
                variant="default"
                size="sm"
                onClick={() =>
                  redirectToPricing({
                    surface: "message_error_state",
                    source: "rate_limit_error",
                    from_tier: subscription,
                    reason: capReason,
                    cta_text: "Upgrade Plan",
                  })
                }
              >
                Upgrade Plan
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
                <Button variant="destructive" size="sm" onClick={onRetry}>
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
