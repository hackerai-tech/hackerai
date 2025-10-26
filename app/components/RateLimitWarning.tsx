import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { redirectToPricing } from "../hooks/usePricingDialog";
import type { ChatMode, SubscriptionTier } from "@/types";

interface RateLimitWarningProps {
  remaining: number;
  resetTime: Date;
  mode: ChatMode;
  subscription: SubscriptionTier;
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

  // For short durations (< 6 hours), show relative time
  if (hoursUntil < 6) {
    if (hoursUntil === 0) {
      return `in ${minutesUntil} ${minutesUntil === 1 ? "minute" : "minutes"}`;
    }
    if (minutesUntil === 0) {
      return `in ${hoursUntil} ${hoursUntil === 1 ? "hour" : "hours"}`;
    }
    return `in ${hoursUntil}h ${minutesUntil}m`;
  }

  // For longer durations, show the actual time
  const hours = resetTime.getHours();
  const minutes = resetTime.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, "0");
  const timeStr = `${displayHours}:${displayMinutes} ${ampm}`;

  // Check if it's today or tomorrow by creating tomorrow's date
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(tomorrow);
  dayAfter.setDate(dayAfter.getDate() + 1);

  const resetDate = new Date(resetTime);
  resetDate.setHours(0, 0, 0, 0);

  if (resetDate.getTime() === today.getTime()) {
    return `${timeStr} today`;
  }
  if (resetDate.getTime() === tomorrow.getTime()) {
    return `${timeStr} tomorrow`;
  }

  // For dates further out, include the date
  const monthNames = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${timeStr} on ${monthNames[resetTime.getMonth()]} ${resetTime.getDate()}`;
};

export const RateLimitWarning = ({
  remaining,
  resetTime,
  mode,
  subscription,
  onDismiss,
}: RateLimitWarningProps) => {
  const timeString = formatTimeUntil(resetTime);
  const isFree = subscription === "free";

  // Different message when user has 0 remaining
  const message =
    remaining === 0
      ? `You've reached your ${mode} mode limit. It resets ${timeString}.`
      : `You have ${remaining} ${remaining === 1 ? "response" : "responses"} from ${mode} mode remaining until it resets ${timeString}.`;

  return (
    <div className="mb-2 px-3 py-2.5 bg-input-chat border border-black/8 dark:border-border rounded-lg flex items-center justify-between gap-2">
      <div className="flex-1 flex items-center gap-2 flex-wrap">
        <span className="text-foreground">{message}</span>
        {isFree && (
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
