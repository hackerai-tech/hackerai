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

  // Check if it's today or tomorrow
  const resetDay = resetTime.getDate();
  const todayDay = now.getDate();
  const resetMonth = resetTime.getMonth();
  const todayMonth = now.getMonth();
  const resetYear = resetTime.getFullYear();
  const todayYear = now.getFullYear();

  const isToday =
    resetDay === todayDay &&
    resetMonth === todayMonth &&
    resetYear === todayYear;
  const isTomorrow =
    resetDay === todayDay + 1 &&
    resetMonth === todayMonth &&
    resetYear === todayYear;

  // Format time as 12-hour with AM/PM
  const hours = resetTime.getHours();
  const minutes = resetTime.getMinutes();
  const ampm = hours >= 12 ? "PM" : "AM";
  const displayHours = hours % 12 || 12;
  const displayMinutes = minutes.toString().padStart(2, "0");
  const timeStr = `${displayHours}:${displayMinutes} ${ampm}`;

  if (isToday) {
    return `${timeStr} today`;
  } else if (isTomorrow) {
    return `${timeStr} tomorrow`;
  } else {
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
    return `${timeStr} on ${monthNames[resetMonth]} ${resetDay}`;
  }
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
