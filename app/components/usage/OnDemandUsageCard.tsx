"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import type { SubscriptionTier } from "@/types";

interface OnDemandUsageCardProps {
  subscription: SubscriptionTier;
}

const OnDemandUsageCard = ({ subscription }: OnDemandUsageCardProps) => {
  const extraUsageSettings = useQuery(api.extraUsage.getExtraUsageSettings);
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
  );

  const extraUsageEnabled = userCustomization?.extra_usage_enabled ?? false;
  const monthlyCapDollars = extraUsageSettings?.monthlyCapDollars;
  const monthlySpentDollars = extraUsageSettings?.monthlySpentDollars ?? 0;

  const handleOpenExtraUsage = () => {
    openSettingsDialog("Extra Usage");
  };

  return (
    <div className="rounded-lg border bg-card p-4 space-y-3">
      <p className="text-xs text-muted-foreground">
        On-Demand Usage
        {subscription === "team" ? " (Team)" : ""}
      </p>
      {extraUsageEnabled && extraUsageSettings ? (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums">
              ${monthlySpentDollars.toFixed(0)}
            </span>
            {monthlyCapDollars ? (
              <span className="text-sm text-muted-foreground">
                / ${monthlyCapDollars.toFixed(0)}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">/ No limit</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Pay for extra usage beyond your plan limits.
          </p>
          <div className="text-xs text-muted-foreground">
            ${extraUsageSettings.balanceDollars.toFixed(2)} balance
            {extraUsageSettings.autoReloadEnabled && (
              <span> · Auto-reload on</span>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums text-muted-foreground">
              Off
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Pay for extra usage beyond your plan limits.
          </p>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenExtraUsage}
              className="h-7 text-xs"
              aria-label="Set up extra usage"
            >
              Set Limit
            </Button>
            <span className="text-xs text-muted-foreground">Off</span>
          </div>
        </>
      )}
    </div>
  );
};

export { OnDemandUsageCard };
