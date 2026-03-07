"use client";

import { useState, useEffect } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { RefreshCw } from "lucide-react";
import { ExtraUsageSection } from "@/app/components/ExtraUsageSection";

type MonthlyUsageStatus = {
  usedDollars: number;
  includedDollars: number;
  remainingDollars: number;
  usagePercentage: number;
  resetTime: string | null;
};

const UsageTab = () => {
  const { subscription } = useGlobalState();
  const [usage, setUsage] = useState<MonthlyUsageStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const getAgentRateLimitStatus = useAction(
    api.rateLimitStatus.getAgentRateLimitStatus,
  );

  const fetchUsage = async () => {
    if (subscription === "free") {
      setUsage(null);
      return;
    }

    setIsLoading(true);
    try {
      const status = await getAgentRateLimitStatus({ subscription });
      setUsage(status);
    } catch (error) {
      console.error("Failed to fetch usage:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchUsage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscription]);

  const formatResetDate = (resetTime: string | null): string => {
    if (!resetTime) return "";
    const reset = new Date(resetTime);
    return reset.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const getBarColorClass = (percentage: number): string => {
    if (percentage >= 90) return "bg-red-500";
    if (percentage >= 70) return "bg-orange-500";
    return "bg-blue-500";
  };

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
        <div className="font-medium">Your included usage</div>
        <Button
          variant="ghost"
          size="sm"
          onClick={fetchUsage}
          disabled={isLoading}
          className="h-8 px-2"
          aria-label="Refresh usage"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {usage ? (
        <div className="space-y-4">
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-1">
              <span className="text-2xl font-semibold">
                ${(usage.remainingDollars ?? 0).toFixed(2)}
              </span>
              <span className="text-sm text-muted-foreground">
                / ${(usage.includedDollars ?? 0).toFixed(2)}
              </span>
            </div>
            {usage.resetTime && (
              <div className="text-xs text-muted-foreground">
                Resets {formatResetDate(usage.resetTime)}
              </div>
            )}
          </div>

          <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all duration-500 ${getBarColorClass(usage.usagePercentage ?? 0)}`}
              style={{ width: `${usage.usagePercentage ?? 0}%` }}
            />
          </div>

          <div className="text-xs text-muted-foreground">
            ${(usage.usedDollars ?? 0).toFixed(2)} used this period
          </div>
        </div>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <RefreshCw className="h-4 w-4 animate-spin" />
          <span>Loading usage...</span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-2">
          Unable to load usage data.
        </p>
      )}

      {/* Extra Usage Section - hidden for team users */}
      {subscription !== "team" && <ExtraUsageSection />}
    </div>
  );
};

export { UsageTab };
