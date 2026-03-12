"use client";

import { useGlobalState } from "@/app/contexts/GlobalState";
import { IncludedUsageCard } from "@/app/components/usage/IncludedUsageCard";
import { OnDemandUsageCard } from "@/app/components/usage/OnDemandUsageCard";
import { UsageLogsTable } from "@/app/components/usage/UsageLogsTable";

const UsageTab = () => {
  const { subscription } = useGlobalState();

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
    <div className="space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <IncludedUsageCard subscription={subscription} />
        <OnDemandUsageCard subscription={subscription} />
      </div>
      <UsageLogsTable />
    </div>
  );
};

export { UsageTab };
