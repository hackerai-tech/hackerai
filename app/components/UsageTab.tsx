"use client";

import { useState, useEffect } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { RefreshCw } from "lucide-react";
import { ExtraUsageSection } from "@/app/components/ExtraUsageSection";

// Usage limit status type
type UsageLimitStatus = {
  remaining: number;
  limit: number;
  used: number;
  usagePercentage: number;
  resetTime: string | null;
};

// Token usage status type
type TokenUsageStatus = {
  session: UsageLimitStatus;
  weekly: UsageLimitStatus;
  dailyBudgetUsd: number;
  weeklyBudgetUsd: number;
};

const UsageTab = () => {
  const { subscription } = useGlobalState();

  // Token usage state
  const [tokenUsage, setTokenUsage] = useState<TokenUsageStatus | null>(null);
  const [isLoadingUsage, setIsLoadingUsage] = useState(false);
  const getAgentRateLimitStatus = useAction(
    api.rateLimitStatus.getAgentRateLimitStatus,
  );

  // Fetch token usage
  const fetchTokenUsage = async () => {
    if (subscription === "free") {
      setTokenUsage(null);
      return;
    }

    setIsLoadingUsage(true);
    try {
      const status = await getAgentRateLimitStatus({ subscription });
      setTokenUsage(status);
    } catch (error) {
      console.error("Failed to fetch token usage:", error);
    } finally {
      setIsLoadingUsage(false);
    }
  };

  // Fetch token usage on mount and when subscription changes
  useEffect(() => {
    fetchTokenUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription]);

  // Format reset time for session (hours/minutes)
  const formatSessionResetTime = (resetTime: string | null): string => {
    if (!resetTime) return "Unknown";
    const reset = new Date(resetTime);
    const now = new Date();
    const diffMs = reset.getTime() - now.getTime();

    if (diffMs <= 0) return "Resetting soon...";

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
      return `Resets in ${hours} hr ${minutes} min`;
    }
    return `Resets in ${minutes} min`;
  };

  // Format reset time for weekly (day and time)
  const formatWeeklyResetTime = (resetTime: string | null): string => {
    if (!resetTime) return "Unknown";
    const reset = new Date(resetTime);
    const now = new Date();
    const diffMs = reset.getTime() - now.getTime();

    if (diffMs <= 0) return "Resetting soon...";

    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dayName = days[reset.getDay()];
    const hours = reset.getHours();
    const minutes = reset.getMinutes();
    const ampm = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 || 12;
    const timeStr = `${hour12}:${minutes.toString().padStart(2, "0")}${ampm}`;

    return `Resets ${dayName} at ${timeStr}`;
  };

  // Get color class based on usage percentage
  const getUsageColorClass = (percentage: number): string => {
    if (percentage >= 90) return "bg-red-500";
    if (percentage >= 70) return "bg-orange-500";
    return "bg-blue-500";
  };

  // Show upgrade message for free users
  if (subscription === "free") {
    return (
      <div className="space-y-6">
        <div className="py-4">
          <p className="text-sm text-muted-foreground">
            Upgrade to Pro, Ultra, or Team to access detailed usage tracking and
            limits.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between py-3">
        <div className="font-medium">Plan usage limits</div>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchTokenUsage}
          disabled={isLoadingUsage}
          className="h-8 px-2"
          aria-label="Refresh usage"
        >
          <RefreshCw
            className={`h-4 w-4 ${isLoadingUsage ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {tokenUsage ? (
        <div className="space-y-6">
          {/* Agent Mode Session */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">Current session</div>
                <div className="text-xs text-muted-foreground">
                  {formatSessionResetTime(tokenUsage.session.resetTime)}
                </div>
              </div>
              <div className="text-sm text-muted-foreground">
                {tokenUsage.session.usagePercentage}% used
              </div>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full transition-all duration-500 ${getUsageColorClass(tokenUsage.session.usagePercentage)}`}
                style={{ width: `${tokenUsage.session.usagePercentage}%` }}
              />
            </div>
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Agent Mode Weekly */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">Weekly usage</div>
                <div className="text-xs text-muted-foreground">
                  {formatWeeklyResetTime(tokenUsage.weekly.resetTime)}
                </div>
              </div>
              <div className="text-sm text-muted-foreground">
                {tokenUsage.weekly.usagePercentage}% used
              </div>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full transition-all duration-500 ${getUsageColorClass(tokenUsage.weekly.usagePercentage)}`}
                style={{ width: `${tokenUsage.weekly.usagePercentage}%` }}
              />
            </div>
          </div>
        </div>
      ) : isLoadingUsage ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>Loading usage...</span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-2">
          Unable to load usage limits.
        </p>
      )}

      {/* Extra Usage Section - hidden for team users */}
      {subscription !== "team" && <ExtraUsageSection />}
    </div>
  );
};

export { UsageTab };
