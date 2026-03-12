import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
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
      bucketType: "monthly";
      remainingPercent: number;
      resetTime: Date;
      subscription: SubscriptionTier;
      severity?: "info" | "warning";
      usedDollars?: number;
      limitDollars?: number;
    }
  | {
      warningType: "extra-usage-active";
      bucketType: "monthly";
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
    return data.remaining === 0
      ? `You've reached your ${data.mode} mode limit. It resets ${timeString}.`
      : `You have ${data.remaining} ${data.remaining === 1 ? "response" : "responses"} in ${data.mode} mode remaining until it resets ${timeString}.`;
  }

  if (data.warningType === "extra-usage-active") {
    return `You're now using extra usage credits. Your monthly limit resets ${timeString}.`;
  }

  // Token bucket warning — show dollar amounts when available
  if (data.remainingPercent === 0) {
    return `You've reached your monthly usage limit. It resets ${timeString}.`;
  }

  const usedPercent = 100 - data.remainingPercent;
  if (data.usedDollars !== undefined && data.limitDollars !== undefined) {
    return `You've used $${data.usedDollars.toFixed(2)} of $${data.limitDollars.toFixed(2)} (${usedPercent}%). Resets ${timeString}.`;
  }

  return `You have ${data.remainingPercent}% of your monthly usage remaining. It resets ${timeString}.`;
};

const WARNING_STYLES = "bg-input-chat border-black/8 dark:border-border";

export const RateLimitWarning = ({
  data,
  onDismiss,
}: RateLimitWarningProps) => {
  const timeString = formatTimeUntil(data.resetTime);
  const message = getMessage(data, timeString);
  const showUpgrade =
    data.warningType !== "extra-usage-active" &&
    (data.subscription === "free" ||
      data.subscription === "pro" ||
      data.subscription === "pro-plus");
  const showAddCredits =
    data.warningType === "token-bucket" && data.subscription !== "free";

  return (
    <div
      data-testid="rate-limit-warning"
      className={`mb-2 px-3 py-2.5 border rounded-[22px] flex items-center justify-between gap-2 ${WARNING_STYLES}`}
    >
      <div className="flex-1 flex items-center gap-2 flex-wrap">
        <span className="text-foreground text-sm">{message}</span>
        {showAddCredits && (
          <Button
            onClick={() => openSettingsDialog("Extra Usage")}
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs font-medium border-black/8 dark:border-border"
          >
            Add credits
          </Button>
        )}
        {showUpgrade && (
          <Button
            onClick={redirectToPricing}
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs font-medium border-black/8 dark:border-border"
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
