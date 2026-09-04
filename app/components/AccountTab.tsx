"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { usePentestgptMigration } from "@/app/hooks/usePentestgptMigration";
import {
  BadgePercent,
  CalendarClock,
  X,
  ChevronDown,
  Loader2,
  PauseCircle,
  Play,
  Sparkle,
  Undo2,
} from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  proFeatures,
  proPlusFeatures,
  ultraFeatures,
  teamFeatures,
} from "@/lib/pricing/features";
import DeleteAccountDialog from "./DeleteAccountDialog";
import CancelSubscriptionDialog from "./CancelSubscriptionDialog";
import {
  getSubscriptionCancellationStatus,
  keepSubscription,
  redirectToBillingPortal as openBillingPortal,
  resumeSubscription,
} from "@/lib/billing/client";
import type {
  AcceptRetentionDiscountResult,
  BillingPortalFlow,
  PauseSubscriptionResult,
  SubscriptionCancellationStatus,
} from "@/lib/billing/api-types";
import type { SubscriptionTier } from "@/types";
import { PastDueBillingBanner } from "./PastDueBillingBanner";
import { reloadWithEntitlementRefresh } from "@/lib/auth/entitlement-refresh-navigation";

type AccountCancellationStatus = SubscriptionCancellationStatus & {
  subscription: SubscriptionTier;
};

function formatCancellationDate(currentPeriodEnd?: number) {
  if (!currentPeriodEnd) return null;

  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(currentPeriodEnd));
}

function getPlanDisplayName(tier: SubscriptionTier | undefined) {
  switch (tier) {
    case "ultra":
      return "Ultra";
    case "team":
      return "Team";
    case "pro-plus":
      return "Pro+";
    case "pro":
      return "Pro";
    default:
      return "paid";
  }
}

function formatRenewalPrice(status: AccountCancellationStatus | null) {
  if (
    status?.cancelAtPeriodEnd ||
    status?.renewalAmountDollars === undefined ||
    !status.renewalCurrency ||
    !status.renewalInterval
  ) {
    return null;
  }

  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: status.renewalCurrency.toUpperCase(),
    maximumFractionDigits: Number.isInteger(status.renewalAmountDollars)
      ? 0
      : 2,
  }).format(status.renewalAmountDollars);
  const intervalCount = status.renewalIntervalCount ?? 1;
  const interval =
    intervalCount === 1
      ? status.renewalInterval
      : `${intervalCount} ${status.renewalInterval}s`;
  return `${amount} every ${interval}`;
}

const AccountTab = () => {
  const { subscription, setMigrateFromPentestgptDialogOpen } = useGlobalState();
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [isKeepingPlan, setIsKeepingPlan] = useState(false);
  const [isResumingPlan, setIsResumingPlan] = useState(false);
  const [isOpeningBillingPortal, setIsOpeningBillingPortal] = useState(false);
  // Paused plans drop to the free tier, so the pause record is the only
  // signal that a "Resume now" action applies.
  const activePause = useQuery(
    api.subscriptionPauses.getMyActivePause,
    subscription === "free" ? {} : "skip",
  );
  const [isTeamAdmin, setIsTeamAdmin] = useState<boolean | null>(null);
  const [cancellationStatus, setCancellationStatus] =
    useState<AccountCancellationStatus | null>(null);
  const { isMigrating } = usePentestgptMigration();

  // Fetch admin status for team subscriptions
  useEffect(() => {
    if (subscription === "team") {
      fetch("/api/team/members")
        .then((res) => res.json())
        .then((data) => setIsTeamAdmin(data.isAdmin ?? false))
        .catch(() => setIsTeamAdmin(false));
    }
  }, [subscription]);

  // For individual plans (pro/pro-plus/ultra), user always has billing access
  // For team plans, only admins can manage billing
  const canManageBilling =
    subscription === "pro" ||
    subscription === "pro-plus" ||
    subscription === "ultra" ||
    (subscription === "team" && isTeamAdmin === true);

  const currentPlanFeatures =
    subscription === "team"
      ? teamFeatures
      : subscription === "pro-plus"
        ? proPlusFeatures
        : proFeatures;
  const hasCurrentCancellationStatus =
    canManageBilling && cancellationStatus?.subscription === subscription;
  const currentCancellationStatus = hasCurrentCancellationStatus
    ? cancellationStatus
    : null;
  const cancellationEndDate = formatCancellationDate(
    currentCancellationStatus?.currentPeriodEnd,
  );
  const renewalPrice = formatRenewalPrice(currentCancellationStatus);
  const noActiveSubscription =
    currentCancellationStatus?.hasActiveSubscription === false;
  const cancellationScheduled =
    currentCancellationStatus?.cancelAtPeriodEnd === true;
  const scheduledPause = cancellationScheduled
    ? (currentCancellationStatus?.pause ?? null)
    : null;
  const pauseResumeDate = formatCancellationDate(scheduledPause?.resumeAt);
  const retentionDiscount = currentCancellationStatus?.retentionDiscount;
  const pausedPlan =
    subscription === "free" &&
    activePause &&
    activePause.status !== "scheduled" &&
    activePause.status !== "canceled"
      ? activePause
      : null;
  const pausedPlanResumeDate = formatCancellationDate(pausedPlan?.resumeAt);
  const pastDueStatus =
    currentCancellationStatus?.subscriptionStatus === "past_due"
      ? "past_due"
      : null;
  const isCheckingCancellationStatus =
    canManageBilling && !hasCurrentCancellationStatus;

  useEffect(() => {
    if (!canManageBilling || hasCurrentCancellationStatus) return;

    let ignore = false;

    getSubscriptionCancellationStatus()
      .then((status) => {
        if (!ignore) setCancellationStatus({ ...status, subscription });
      })
      .catch((error) => {
        if (!ignore) {
          console.warn(
            "Failed to load subscription cancellation status",
            error,
          );
          setCancellationStatus({
            subscription,
            hasActiveSubscription: false,
            cancelAtPeriodEnd: false,
          });
        }
      });

    return () => {
      ignore = true;
    };
  }, [canManageBilling, hasCurrentCancellationStatus, subscription]);

  const redirectToBillingPortal = async (flow?: BillingPortalFlow) => {
    if (isOpeningBillingPortal) return;
    setIsOpeningBillingPortal(true);
    try {
      const url = await openBillingPortal(flow);
      window.location.href = url;
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to open billing portal",
      );
      setIsOpeningBillingPortal(false);
    }
  };

  const handleCancelSubscription = () => {
    setShowCancelDialog(true);
  };

  const handleCancellationCompleted = ({
    cancelAtPeriodEnd,
    currentPeriodEnd,
  }: {
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd?: number;
  }) => {
    setCancellationStatus({
      subscription,
      hasActiveSubscription: cancelAtPeriodEnd,
      cancelAtPeriodEnd,
      currentPeriodEnd: cancelAtPeriodEnd ? currentPeriodEnd : undefined,
    });
  };

  const handlePauseScheduled = (result: PauseSubscriptionResult) => {
    setCancellationStatus({
      ...(currentCancellationStatus ?? {}),
      subscription,
      hasActiveSubscription: true,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: result.pauseEffectiveAt,
      pause: {
        months: result.months,
        pauseEffectiveAt: result.pauseEffectiveAt,
        resumeAt: result.resumeAt,
      },
    });
  };

  const handleDiscountApplied = (result: AcceptRetentionDiscountResult) => {
    setCancellationStatus({
      ...(currentCancellationStatus ?? {}),
      subscription,
      hasActiveSubscription: true,
      cancelAtPeriodEnd: false,
      retentionDiscount: {
        percentOff: result.percentOff,
        durationMonths: result.durationMonths,
        appliedAt: Date.now(),
      },
    });
  };

  const handleKeepPlan = async () => {
    if (isKeepingPlan) return;

    const wasPause = Boolean(scheduledPause);
    setIsKeepingPlan(true);
    try {
      const result = await keepSubscription();
      setCancellationStatus({
        ...(currentCancellationStatus ?? {}),
        subscription,
        hasActiveSubscription: true,
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
        currentPeriodEnd: result.currentPeriodEnd,
        pause: undefined,
      });
      toast.success(
        wasPause
          ? "Pause canceled. Your plan will renew as usual."
          : "Cancellation removed. Your plan will renew as usual.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to keep plan active",
      );
    } finally {
      setIsKeepingPlan(false);
    }
  };

  const handleResumePlan = async () => {
    if (isResumingPlan) return;

    setIsResumingPlan(true);
    try {
      const result = await resumeSubscription();
      toast.success(
        result.alreadyActive
          ? "Your plan is already active. Refreshing your account..."
          : "Plan resumed. Refreshing your account...",
      );
      // Entitlements come from the WorkOS session, so reload with the same
      // refresh hint the PentestGPT migration uses.
      reloadWithEntitlementRefresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to resume plan",
      );
      setIsResumingPlan(false);
    }
  };

  const handleOpenMigrateConfirm = () => {
    if (isMigrating) return;
    setMigrateFromPentestgptDialogOpen(true);
  };

  return (
    <div className="space-y-6 min-h-0">
      <div className="border-b py-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">
              {subscription === "ultra"
                ? "HackerAI Ultra"
                : subscription === "team"
                  ? "HackerAI Team"
                  : subscription === "pro-plus"
                    ? "HackerAI Pro+"
                    : subscription === "pro"
                      ? "HackerAI Pro"
                      : "Get HackerAI Pro"}
            </div>
            {renewalPrice && (
              <div className="mt-0.5 text-sm text-muted-foreground">
                Renews at {renewalPrice}
              </div>
            )}
            {retentionDiscount && !cancellationScheduled && (
              <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                <BadgePercent className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {`${retentionDiscount.percentOff}% off applied to your next ${retentionDiscount.durationMonths} renewal${retentionDiscount.durationMonths === 1 ? "" : "s"}`}
                </span>
              </div>
            )}
          </div>
          {subscription !== "free" ? (
            canManageBilling ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isKeepingPlan}
                  >
                    {isKeepingPlan ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Keeping...</span>
                      </>
                    ) : (
                      <>
                        <span>Manage</span>
                        <ChevronDown className="h-4 w-4" />
                      </>
                    )}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  {(subscription === "pro" || subscription === "pro-plus") && (
                    <>
                      <DropdownMenuItem
                        onClick={() =>
                          redirectToPricing({
                            surface: "account_tab_manage_menu",
                            source: "account_settings",
                            from_tier: subscription,
                            cta_text: "Upgrade plan",
                          })
                        }
                      >
                        <Sparkle className="h-4 w-4" />
                        <span>Upgrade plan</span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {cancellationScheduled ? (
                    <>
                      <DropdownMenuItem disabled>
                        {scheduledPause ? (
                          <PauseCircle className="h-4 w-4" />
                        ) : (
                          <CalendarClock className="h-4 w-4" />
                        )}
                        <span>
                          {scheduledPause
                            ? "Pause scheduled"
                            : "Cancellation scheduled"}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={handleKeepPlan}
                        disabled={isKeepingPlan}
                      >
                        {isKeepingPlan ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Undo2 className="h-4 w-4" />
                        )}
                        <span>
                          {scheduledPause ? "Cancel pause" : "Keep plan"}
                        </span>
                      </DropdownMenuItem>
                    </>
                  ) : noActiveSubscription ? (
                    <DropdownMenuItem disabled>
                      <CalendarClock className="h-4 w-4" />
                      <span>No active subscription</span>
                    </DropdownMenuItem>
                  ) : isCheckingCancellationStatus ? (
                    <DropdownMenuItem disabled>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Checking subscription</span>
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={handleCancelSubscription}
                    >
                      <X className="h-4 w-4" />
                      <span>Cancel subscription</span>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null
          ) : (
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={() =>
                redirectToPricing({
                  surface: "account_tab",
                  source: "account_settings",
                  from_tier: subscription,
                  cta_text: "Upgrade",
                })
              }
            >
              Upgrade
            </Button>
          )}
        </div>

        {cancellationScheduled && scheduledPause && (
          <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Pause scheduled.
            </span>{" "}
            {cancellationEndDate
              ? `Your plan stays active until ${cancellationEndDate}.`
              : "Your plan stays active until the end of the current billing period."}{" "}
            {pauseResumeDate
              ? `Billing pauses after that and resumes automatically on ${pauseResumeDate}.`
              : `Billing pauses after that for ${scheduledPause.months} month${scheduledPause.months === 1 ? "" : "s"}.`}
          </div>
        )}

        {cancellationScheduled && !scheduledPause && (
          <div className="mt-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              Cancellation scheduled.
            </span>{" "}
            {cancellationEndDate
              ? `Your plan stays active until ${cancellationEndDate}.`
              : "Your plan stays active until the end of the current billing period."}
          </div>
        )}

        {pausedPlan && (
          <div
            role="status"
            className="mt-3 flex flex-col gap-3 rounded-md border border-border bg-muted/40 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex min-w-0 items-start gap-3">
              <PauseCircle
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
              />
              <div className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {`Your ${getPlanDisplayName(pausedPlan.subscriptionTier)} plan is paused.`}
                </span>{" "}
                {pausedPlan.status === "resume_failed"
                  ? "We couldn't resume it automatically with your saved card. Update your payment method, then resume."
                  : pausedPlanResumeDate
                    ? `It resumes automatically on ${pausedPlanResumeDate}. Resume sooner anytime.`
                    : "It resumes automatically on the scheduled date. Resume sooner anytime."}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={isResumingPlan}
              onClick={() => void handleResumePlan()}
            >
              {isResumingPlan ? (
                <>
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin"
                  />
                  Resuming...
                </>
              ) : (
                <>
                  <Play aria-hidden="true" className="h-4 w-4" />
                  Resume now
                </>
              )}
            </Button>
          </div>
        )}

        {pastDueStatus && subscription !== "free" && (
          <div className="mt-3">
            <PastDueBillingBanner
              surface="account_settings"
              subscription={subscription}
              subscriptionStatus={pastDueStatus}
              latestInvoiceId={currentCancellationStatus?.latestInvoiceId}
              isOpening={isOpeningBillingPortal}
              onUpdatePayment={() =>
                void redirectToBillingPortal("payment_method")
              }
            />
          </div>
        )}

        <div className="mt-2 rounded-lg bg-transparent px-0">
          <span className="text-sm font-semibold inline-block pb-4">
            {subscription === "ultra"
              ? "Thanks for subscribing to Ultra! Your plan includes everything in Pro, plus:"
              : subscription === "team"
                ? "Thanks for subscribing to Team! Your plan includes:"
                : subscription === "pro-plus"
                  ? "Thanks for subscribing to Pro+! Your plan includes everything in Pro, plus:"
                  : subscription === "pro"
                    ? "Thanks for subscribing to Pro! Your plan includes:"
                    : "Get everything in Free, and more."}
          </span>
          <ul className="mb-2 flex flex-col gap-5">
            {(subscription === "ultra"
              ? ultraFeatures
              : currentPlanFeatures
            ).map((feature, index) => (
              <li key={index} className="relative">
                <div className="flex justify-start gap-3.5">
                  <feature.icon className="h-5 w-5 shrink-0" />
                  <span className="font-normal">{feature.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {subscription === "free" && (
        <div className="border-b pb-6">
          <div className="flex items-center justify-between py-3">
            <div>
              <div className="font-medium">Migrate from PentestGPT</div>
              <div className="text-sm text-muted-foreground mt-1">
                Transfer your active PentestGPT subscription
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleOpenMigrateConfirm}
              disabled={isMigrating}
            >
              {isMigrating ? "Migrating..." : "Migrate"}
            </Button>
          </div>
        </div>
      )}

      {subscription !== "free" && canManageBilling && (
        <div>
          <div className="space-y-4">
            <div className="flex items-center justify-between py-3">
              <div>
                <div className="font-medium">Payment</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={
                  isOpeningBillingPortal || isCheckingCancellationStatus
                }
                onClick={() =>
                  void redirectToBillingPortal(
                    pastDueStatus ? "payment_method" : undefined,
                  )
                }
              >
                {pastDueStatus ? "Update payment" : "Manage"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Account Section */}
      <div>
        <div className="flex items-center justify-between py-3">
          <div>
            <div className="font-medium">Delete account</div>
          </div>
          <Button
            type="button"
            data-testid="delete-account-button"
            variant="destructive"
            size="sm"
            onClick={() => setShowDeleteAccount(true)}
            aria-label="Delete account"
          >
            Delete
          </Button>
        </div>
      </div>

      <DeleteAccountDialog
        open={showDeleteAccount}
        onOpenChange={setShowDeleteAccount}
      />

      <CancelSubscriptionDialog
        open={showCancelDialog}
        onOpenChange={setShowCancelDialog}
        onCancellationCompleted={handleCancellationCompleted}
        onPauseScheduled={handlePauseScheduled}
        onDiscountApplied={handleDiscountApplied}
      />
    </div>
  );
};

export { AccountTab };
