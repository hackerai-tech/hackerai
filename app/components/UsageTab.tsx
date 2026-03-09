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
  monthly: UsageLimitStatus;
  monthlyBudgetUsd: number;
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

  // Format reset time for monthly (date and time)
  const formatMonthlyResetTime = (resetTime: string | null): string => {
    if (!resetTime) return "Unknown";
    const reset = new Date(resetTime);
    const now = new Date();
    const diffMs = reset.getTime() - now.getTime();

    if (diffMs <= 0) return "Resetting soon...";

    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const hours = Math.floor(
      (diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60),
    );

    if (days > 0) {
      return `Resets in ${days}d ${hours}h`;
    }
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) {
      return `Resets in ${hours}h ${minutes}m`;
    }
    return `Resets in ${minutes}m`;
  };

  // Format points as dollar amount
  const formatPointsAsDollars = (points: number): string => {
    const dollars = points / 10_000;
    return `$${dollars.toFixed(2)}`;
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
          {/* Monthly Usage */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-sm">Monthly usage</div>
                <div className="text-xs text-muted-foreground">
                  {formatMonthlyResetTime(tokenUsage.monthly.resetTime)}
                </div>
              </div>
              <div className="text-sm text-muted-foreground">
                {formatPointsAsDollars(tokenUsage.monthly.used)} /{" "}
                {formatPointsAsDollars(tokenUsage.monthly.limit)} used
              </div>
            </div>
            <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full transition-all duration-500 ${getUsageColorClass(tokenUsage.monthly.usagePercentage)}`}
                style={{ width: `${tokenUsage.monthly.usagePercentage}%` }}
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
