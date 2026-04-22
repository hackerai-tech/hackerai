import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { MemoizedMarkdown } from "./MemoizedMarkdown";
import { ChatSDKError } from "@/lib/errors";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";

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
  const { subscription } = useGlobalState();
  const isRateLimitError =
    error instanceof ChatSDKError && error.type === "rate_limit";

  const metadata = error instanceof ChatSDKError ? error.metadata : undefined;
  const resetTimestamp = metadata?.resetTimestamp as number | undefined;

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

  const isPaidUser = subscription !== "free";
  const canUpgrade =
    subscription === "free" ||
    subscription === "pro" ||
    subscription === "pro-plus";
  const isTrustCapExceeded = metadata?.trustCapExceeded === true;

  return (
    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
      <div className="text-destructive text-sm mb-2">
        {isRateLimitError ? (
          <MemoizedMarkdown content={errorMessage} />
        ) : (
          <p>{errorMessage}</p>
        )}
        {isRateLimitError && timeRemaining > 0 && !isTrustCapExceeded && (
          <p className="text-xs text-muted-foreground mt-1">
            Resets in {formatCountdown(timeRemaining)}
          </p>
        )}
        {isRateLimitError && resetTimestamp && isTrustCapExceeded && (
          <p className="text-xs text-muted-foreground mt-1">
            Your limit resets on{" "}
            {new Date(resetTimestamp).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
            })}
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
            {isTrustCapExceeded && (
              <Button
                variant="default"
                size="sm"
                onClick={() =>
                  window.open("https://help.hackerai.co/", "_blank")
                }
              >
                Contact Support
              </Button>
            )}
            {isPaidUser && !isTrustCapExceeded && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openSettingsDialog("Extra Usage")}
              >
                Add Credits
              </Button>
            )}
            {canUpgrade && !isTrustCapExceeded && (
              <Button variant="default" size="sm" onClick={redirectToPricing}>
                Upgrade Plan
              </Button>
            )}
          </>
        ) : (
          <>
            {onReconnect && (
              <Button variant="default" size="sm" onClick={onReconnect}>
                Reconnect
              </Button>
            )}
            <Button variant="destructive" size="sm" onClick={onRetry}>
              Retry
            </Button>
          </>
        )}
      </div>
    </div>
  );
};
