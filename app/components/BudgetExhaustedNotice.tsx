import { BlockedChatBillingRecovery } from "./BlockedChatBillingRecovery";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { Button } from "@/components/ui/button";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";

interface BudgetExhaustedNoticeProps {
  onContinue?: () => void;
}

/** Mounted only for a stopped run, including when its saved chat is reopened. */
export const BudgetExhaustedNotice = (props: BudgetExhaustedNoticeProps) => (
  <BlockedChatBillingRecovery onRetry={props.onContinue}>
    <UsageBudgetExhaustedNotice {...props} />
  </BlockedChatBillingRecovery>
);

const UsageBudgetExhaustedNotice = ({
  onContinue,
}: BudgetExhaustedNoticeProps) => {
  const { subscription, isCheckingProPlan } = useGlobalState();
  const isPersonalPaid = subscription !== "free" && subscription !== "team";
  const entitlement = useQuery(
    api.extraUsage.getMaxModelExtraUsageEntitlement,
    isPersonalPaid && !isCheckingProPlan ? {} : "skip",
  );
  // Auto-reload alone is not proof that a previously failed charge can succeed.
  // Observe actual usable credit so purchases and cap changes update this notice.
  const hasUsableCredits =
    isPersonalPaid &&
    entitlement?.extraUsageAvailable === true &&
    entitlement.hasBalance;
  const spendingCapReached = entitlement?.reason === "monthly_cap_exhausted";
  const extraUsageDisabled = entitlement?.reason === "disabled";
  const isLoading =
    isCheckingProPlan || (isPersonalPaid && entitlement === undefined);

  const recoveryLabel =
    subscription === "free"
      ? "Upgrade plan"
      : subscription === "team" || entitlement == null || hasUsableCredits
        ? "Manage usage"
        : spendingCapReached
          ? "Manage spending limit"
          : extraUsageDisabled
            ? "Enable Extra Usage"
            : "Add credits";

  const openRecovery = () => {
    if (subscription === "free") {
      redirectToPricing({
        surface: "budget_exhausted_notice",
        source: "limit_pressure",
        from_tier: subscription,
        reason: "free_monthly_exhausted",
        limit_type: "free_monthly",
        cta_text: recoveryLabel,
      });
    } else {
      openSettingsDialog(subscription === "team" ? "Usage" : "Extra Usage");
    }
  };

  return (
    <div className="mt-2 w-full">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
        <span aria-live="polite">
          {hasUsableCredits
            ? "This run stopped at a usage limit. Continue to resume where it stopped."
            : spendingCapReached
              ? "You've reached your Extra Usage spending limit, so this run stopped."
              : "You've reached your usage limit, so this run stopped."}
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            size="sm"
            variant={hasUsableCredits ? "outline" : "default"}
            disabled={isLoading}
            onClick={openRecovery}
          >
            {isLoading ? "Checking usage…" : recoveryLabel}
          </Button>
          {onContinue && (
            <Button
              type="button"
              size="sm"
              variant={hasUsableCredits ? "default" : "outline"}
              disabled={isLoading}
              onClick={() => onContinue()}
            >
              {hasUsableCredits ? "Continue" : "Try again"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
