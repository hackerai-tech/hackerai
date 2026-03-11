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
}

const formatCountdown = (ms: number): string => {
  if (ms <= 0) return "";
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
};

export const MessageErrorState = ({
  error,
  onRetry,
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
    const interval = setInterval(update, 60_000);
    return () => clearInterval(interval);
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

  return (
    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3">
      <div className="text-destructive text-sm mb-2">
        {isRateLimitError ? (
          <MemoizedMarkdown content={errorMessage} />
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
            {isPaidUser && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => openSettingsDialog("Extra Usage")}
              >
                Add Credits
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => openSettingsDialog("Usage")}
            >
              View Usage
            </Button>
            {canUpgrade && (
              <Button variant="default" size="sm" onClick={redirectToPricing}>
                Upgrade Plan
              </Button>
            )}
          </>
        ) : (
          <Button variant="destructive" size="sm" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
};
