import { BlockedChatBillingRecovery } from "./BlockedChatBillingRecovery";
import { useAction, useQuery } from "convex/react";
import useSWR from "swr";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { Button } from "@/components/ui/button";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";

interface BudgetExhaustedNoticeProps {
  onContinue?: () => void | Promise<void>;
  pending?: boolean;
}

/** Mounted only for a stopped run, including when its saved chat is reopened. */
export const BudgetExhaustedNotice = (props: BudgetExhaustedNoticeProps) => (
  <BlockedChatBillingRecovery onRetry={props.onContinue}>
    <UsageBudgetExhaustedNotice {...props} />
  </BlockedChatBillingRecovery>
);

const UsageBudgetExhaustedNotice = ({
  onContinue,
  pending = false,
}: BudgetExhaustedNoticeProps) => {
  const { subscription, isCheckingProPlan } = useGlobalState();
  const { user } = useAuth();
  const isPersonalPaid = subscription !== "free" && subscription !== "team";
  const getAgentRateLimitStatus = useAction(
    api.rateLimitStatus.getAgentRateLimitStatus,
  );
  const {
    data: includedUsage,
    error: includedUsageError,
    isLoading: isCheckingIncludedUsage,
  } = useSWR(
    isPersonalPaid && !isCheckingProPlan && user
      ? ["budget-exhausted-included-usage", user.id, subscription]
      : null,
    () => getAgentRateLimitStatus({ subscription }),
    {
      revalidateOnFocus: true,
      refreshInterval: 60_000,
      shouldRetryOnError: false,
    },
  );
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
  const hasIncludedUsage =
    includedUsage?.monthlyStatusConfirmed === true &&
    includedUsage.monthly.remaining > 0;
  const isIncludedUsageUnavailable =
    Boolean(includedUsageError) ||
    includedUsage?.monthlyStatusConfirmed === false;
  const canContinue = hasIncludedUsage || Boolean(hasUsableCredits);
  const spendingCapReached = entitlement?.reason === "monthly_cap_exhausted";
  const extraUsageDisabled = entitlement?.reason === "disabled";
  const isLoading =
    isCheckingProPlan ||
    (isPersonalPaid && (entitlement === undefined || isCheckingIncludedUsage));

  const recoveryLabel =
    subscription === "free"
      ? "Upgrade plan"
      : subscription === "team" ||
          entitlement == null ||
          canContinue ||
          isIncludedUsageUnavailable
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
      openSettingsDialog(
        subscription === "team" ||
          isIncludedUsageUnavailable ||
          hasIncludedUsage
          ? "Usage"
          : "Extra Usage",
      );
    }
  };

  return (
    <div className="mt-2 w-full">
      <div className="bg-muted text-muted-foreground rounded-lg px-3 py-2 border border-border flex items-center justify-between gap-3 flex-wrap">
        <span aria-live="polite">
          {canContinue
            ? "This run stopped at a usage limit. Usage is available now; Continue to resume where it stopped."
            : isIncludedUsageUnavailable
              ? "This run stopped at a usage limit. We couldn't check your current allowance; try again or view Usage."
              : spendingCapReached
                ? "This run stopped when your Extra Usage spending limit was reached."
                : "This run stopped when your usage limit was reached."}
        </span>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            type="button"
            size="sm"
            variant={canContinue ? "outline" : "default"}
            disabled={isLoading}
            onClick={openRecovery}
          >
            {isLoading ? "Checking usage…" : recoveryLabel}
          </Button>
          {onContinue && (
            <Button
              type="button"
              size="sm"
              variant={canContinue ? "default" : "outline"}
              disabled={isLoading || pending}
              onClick={() => void onContinue()}
            >
              {pending ? "Resuming…" : canContinue ? "Continue" : "Try again"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};
