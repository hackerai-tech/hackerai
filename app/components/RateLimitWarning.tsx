import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { redirectToPricing } from "../hooks/usePricingDialog";
import type { ChatMode, SubscriptionTier } from "@/types";

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
      bucketType: "session" | "weekly";
      remainingPercent: number;
      resetTime: Date;
      subscription: SubscriptionTier;
    }
  | {
      warningType: "extra-usage-active";
      bucketType: "session" | "weekly";
      resetTime: Date;
      subscription: SubscriptionTier;
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

  const hoursUntil = Math.floor(timeDiff / (1000 * 60 * 60));
  const minutesUntil = Math.floor((timeDiff % (1000 * 60 * 60)) / (1000 * 60));

  if (hoursUntil === 0 && minutesUntil === 0) {
    return "in less than a minute";
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
    return data.remaining === 0
      ? `You've reached your ${data.mode} mode limit. It resets ${timeString}.`
      : `You have ${data.remaining} ${data.remaining === 1 ? "response" : "responses"} in ${data.mode} mode remaining until it resets ${timeString}.`;
  }

  if (data.warningType === "extra-usage-active") {
    const limitType = data.bucketType === "session" ? "session" : "weekly";
    return `You're now using extra usage credits. Your ${limitType} limit resets ${timeString}.`;
  }

  // Token bucket warning
  const limitType = data.bucketType === "session" ? "session" : "weekly";
  return data.remainingPercent === 0
    ? `You've reached your ${limitType} usage limit. It resets ${timeString}.`
    : `You have ${data.remainingPercent}% of your ${limitType} usage remaining. It resets ${timeString}.`;
};

export const RateLimitWarning = ({
  data,
  onDismiss,
}: RateLimitWarningProps) => {
  const timeString = formatTimeUntil(data.resetTime);
  const message = getMessage(data, timeString);
  const showUpgrade =
    data.warningType !== "extra-usage-active" &&
    (data.subscription === "free" ||
      (data.warningType === "token-bucket" && data.subscription === "pro"));

  return (
    <div
      data-testid="rate-limit-warning"
      className="mb-2 px-3 py-2.5 bg-input-chat border border-black/8 dark:border-border rounded-lg flex items-center justify-between gap-2"
    >
      <div className="flex-1 flex items-center gap-2 flex-wrap">
        <span className="text-foreground">{message}</span>
        {showUpgrade && (
          <Button
            onClick={redirectToPricing}
            size="sm"
            variant="default"
            className="h-7 px-3 text-xs font-medium"
          >
            Upgrade plan
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
