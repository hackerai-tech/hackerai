"use client";

import { useState, useEffect, useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { RefreshCw, Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import type { SubscriptionTier } from "@/types";

type UsageLimitStatus = {
  remaining: number;
  limit: number;
  used: number;
  usagePercentage: number;
  resetTime: string | null;
};

type TokenUsageStatus = {
  monthly: UsageLimitStatus;
  monthlyBudgetUsd: number;
};

const formatPointsAsDollars = (points: number): string => {
  const dollars = points / 10_000;
  return `$${dollars.toFixed(2)}`;
};

const formatResetDateShort = (resetTime: string | null): string => {
  if (!resetTime) return "";
  const date = new Date(resetTime);
  return `Resets ${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
};

const formatResetDateFull = (resetTime: string | null): string => {
  if (!resetTime) return "";
  const date = new Date(resetTime);
  return date.toLocaleString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
};

const getUsageColorClass = (percentage: number): string => {
  if (percentage >= 90) return "bg-red-500";
  if (percentage >= 70) return "bg-orange-500";
  return "bg-blue-500";
};

interface IncludedUsageCardProps {
  subscription: SubscriptionTier;
}

const IncludedUsageCard = ({ subscription }: IncludedUsageCardProps) => {
  const [tokenUsage, setTokenUsage] = useState<TokenUsageStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const getAgentRateLimitStatus = useAction(
    api.rateLimitStatus.getAgentRateLimitStatus,
  );

  const fetchTokenUsage = useCallback(async () => {
    if (subscription === "free") {
      setTokenUsage(null);
      return;
    }

    setIsLoading(true);
    try {
      const status = await getAgentRateLimitStatus({ subscription });
      setTokenUsage(status);
    } catch (error) {
      console.error("Failed to fetch token usage:", error);
    } finally {
      setIsLoading(false);
    }
  }, [subscription, getAgentRateLimitStatus]);

  useEffect(() => {
    fetchTokenUsage();
  }, [fetchTokenUsage]);

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <p className="text-xs text-muted-foreground">Your included usage</p>
      {tokenUsage ? (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums">
              {formatPointsAsDollars(tokenUsage.monthly.used)}
            </span>
            <span className="text-sm text-muted-foreground">
              / {formatPointsAsDollars(tokenUsage.monthly.limit)}
            </span>
          </div>
          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full transition-all duration-500 ${getUsageColorClass(tokenUsage.monthly.usagePercentage)}`}
              style={{
                width: `${Math.min(100, tokenUsage.monthly.usagePercentage)}%`,
              }}
            />
          </div>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <span>{formatResetDateShort(tokenUsage.monthly.resetTime)}</span>
            {tokenUsage.monthly.resetTime && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center p-0.5 rounded hover:bg-muted"
                    aria-label="Show exact reset date and time"
                    tabIndex={0}
                  >
                    <Info className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {formatResetDateFull(tokenUsage.monthly.resetTime)}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </>
      ) : isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          <span>Loading...</span>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground py-3">
          Unable to load usage.
        </p>
      )}
    </div>
  );
};

export { IncludedUsageCard };
