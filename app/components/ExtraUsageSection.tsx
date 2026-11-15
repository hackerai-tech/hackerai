"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  EXTRA_USAGE_BUNDLES,
  getExtraUsageBundle,
} from "@/lib/billing/extra-usage-bundles";
import { toast } from "sonner";
import {
  TurnOffExtraUsageDialog,
  BuyExtraUsageDialog,
  AdjustSpendingLimitDialog,
  AutoReloadDialog,
  AutoReloadDisabledAlert,
} from "@/app/components/extra-usage";
import {
  getApproximateWeeklyExtraUsageSpend,
  getRecommendedExtraUsagePurchaseAmount,
} from "@/app/components/extra-usage/BuyExtraUsageDialog";
import {
  captureAddCreditCtaClick,
  captureAddCreditCtaImpression,
  captureAuthenticatedEvent,
  newCheckoutAttemptId,
} from "@/lib/analytics/client";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";

type BundleCapSnapshot = {
  policyVersion: string;
  periodMonth: string;
  capDollars: number;
  usedDollars: number;
  pendingDollars: number;
  remainingDollars: number;
  historyComplete: boolean;
};

/** Allowance context only; amounts are face-value credit dollars. */
const bundleCapAnalytics = (cap: BundleCapSnapshot) => ({
  bundle_cap_policy_version: cap.policyVersion,
  bundle_cap_period: cap.periodMonth,
  bundle_cap_dollars: cap.capDollars,
  bundle_cap_used_dollars: cap.usedDollars,
  bundle_cap_pending_dollars: cap.pendingDollars,
  bundle_cap_remaining_dollars: cap.remainingDollars,
  bundle_cap_history_complete: cap.historyComplete,
});

const ExtraUsageSection = () => {
  const bundleSavingsId = useId();
  // Server time decides the cap period, but a query only re-runs when its
  // data or arguments change. A second, refresh-keyed subscription re-reads
  // the period on dialog open and at the UTC reset; the base subscription keeps
  // the last answer on screen while that refresh loads.
  const [capRefresh, setCapRefresh] = useState(0);
  const baseCapStatus = useQuery(api.extraUsageBundles.getBundleCapStatus, {});
  const refreshedCapStatus = useQuery(
    api.extraUsageBundles.getBundleCapStatus,
    capRefresh > 0 ? { refresh: capRefresh } : "skip",
  );
  // Null when the existing bundle sales gate is closed for this user.
  const bundleCapStatus = refreshedCapStatus ?? baseCapStatus;
  const bundlesEnabled = !!bundleCapStatus;
  const bundleExposure = useRef(false);
  // Reuse one attempt per bundle so a retry resumes its reservation/session.
  const bundleAttemptRef = useRef<{
    bundleId: string;
    attemptId: string;
  } | null>(null);
  useEffect(() => {
    if (bundleCapStatus && !bundleExposure.current) {
      bundleExposure.current = true;
      captureAuthenticatedEvent("extra_usage_bundles_viewed", {
        surface: "extra_usage_settings",
        offer_version: "v1",
        ...bundleCapAnalytics(bundleCapStatus),
        bundle_cap_eligible:
          bundleCapStatus.remainingDollars >=
          Math.min(...EXTRA_USAGE_BUNDLES.map((offer) => offer.creditDollars)),
      });
    }
  }, [bundleCapStatus]);
  // User customization for extra usage enabled flag
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
  );
  const saveUserCustomization = useMutation(
    api.userCustomization.saveUserCustomization,
  );

  // Extra usage settings (balance and auto-reload config)
  const extraUsageSettings = useQuery(api.extraUsage.getExtraUsageSettings);
  const updateExtraUsageSettings = useMutation(
    api.extraUsage.updateExtraUsageSettings,
  );

  // Convex actions for Stripe operations
  const getPaymentStatus = useAction(api.extraUsageActions.getPaymentStatus);
  const createPurchaseSession = useAction(
    api.extraUsageActions.createPurchaseSession,
  );
  const reconcileBundleHolds = useAction(
    api.extraUsageActions.reconcileBundleHolds,
  );
  const reconcilingHoldsRef = useRef(false);

  // Opening the dialog re-reads the cap from the server. When a checkout is
  // pending, Stripe-expired holds are released first (no new session or
  // credit), so an abandoned checkout cannot keep cheaper bundles disabled.
  const refreshBundleCapOnOpen = async () => {
    if (!bundlesEnabled) return;
    if (
      !bundleCapStatus?.resumableBundleIds?.length ||
      reconcilingHoldsRef.current
    ) {
      setCapRefresh((n) => n + 1);
      return;
    }
    reconcilingHoldsRef.current = true;
    try {
      await reconcileBundleHolds({});
    } catch (error) {
      console.error("Failed to reconcile bundle checkouts:", error);
    } finally {
      reconcilingHoldsRef.current = false;
      setCapRefresh((n) => n + 1);
    }
  };

  // Loading states
  const [isTogglingExtraUsage, setIsTogglingExtraUsage] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Dialog states
  const [showTurnOffDialog, setShowTurnOffDialog] = useState(false);
  const [showBuyDialog, setShowBuyDialog] = useState(false);
  const [showSpendingLimitDialog, setShowSpendingLimitDialog] = useState(false);
  const [showAutoReloadDialog, setShowAutoReloadDialog] = useState(false);
  const capturedBuyCtaImpressionRef = useRef(false);

  // While the purchase dialog is open, re-check the server at the UTC reset.
  // Client time only schedules the re-check; the server decides the period.
  const capResetsAt = bundleCapStatus?.resetsAt;
  useEffect(() => {
    if (!showBuyDialog || typeof capResetsAt !== "number") return;
    const untilReset = capResetsAt - Date.now();
    const delay = Math.min(
      untilReset > 0 ? untilReset + 1_000 : 15_000,
      2_147_483_647,
    );
    const timer = setTimeout(() => setCapRefresh((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [showBuyDialog, capResetsAt, capRefresh]);

  // Extra usage toggle handler
  const handleToggleExtraUsage = async (enabled: boolean) => {
    if (isTogglingExtraUsage) return;

    // If turning off, show confirmation dialog
    if (!enabled) {
      setShowTurnOffDialog(true);
      return;
    }

    setIsTogglingExtraUsage(true);
    try {
      // Check if user has a valid payment method before enabling
      const paymentStatus = await getPaymentStatus();

      if (!paymentStatus.hasPaymentMethod) {
        toast.error(
          "Please add a payment method in the billing portal before enabling extra usage.",
        );
        setIsTogglingExtraUsage(false);
        return;
      }

      await saveUserCustomization({ extra_usage_enabled: true });
      toast.success("Extra usage enabled");
    } catch (error) {
      console.error("Failed to toggle extra usage:", error);
      toast.error("Failed to update extra usage setting");
    } finally {
      setIsTogglingExtraUsage(false);
    }
  };

  // Confirm turn off extra usage
  const handleConfirmTurnOff = async () => {
    setIsTogglingExtraUsage(true);
    try {
      await saveUserCustomization({ extra_usage_enabled: false });
      toast.success("Extra usage disabled");
      setShowTurnOffDialog(false);
    } catch (error) {
      console.error("Failed to turn off extra usage:", error);
      toast.error("Failed to disable extra usage");
    } finally {
      setIsTogglingExtraUsage(false);
    }
  };

  // Purchase credits (redirects to Stripe Checkout with saved cards shown)
  const handlePurchaseCredits = async (
    amountDollars: number,
    bundleId?: string,
  ) => {
    setIsPurchasing(true);
    try {
      const paidDollars = bundleId
        ? getExtraUsageBundle(bundleId).paidDollars
        : amountDollars;
      const checkoutAttemptId =
        bundleId && bundleAttemptRef.current?.bundleId === bundleId
          ? bundleAttemptRef.current.attemptId
          : newCheckoutAttemptId();
      if (bundleId) {
        bundleAttemptRef.current = { bundleId, attemptId: checkoutAttemptId };
      }
      const result = await createPurchaseSession({
        amountDollars,
        ...(bundleId && { bundleId }),
        baseUrl: window.location.origin,
        checkoutAttemptId,
        // Return to the stopped chat so its live balance can offer Continue.
        // The pathname avoids forwarding transient checkout or pricing flags.
        returnPath:
          window.location.pathname.length <= 400
            ? window.location.pathname
            : "/",
      });
      // A resumed checkout keeps the attempt it was created under; adopt it
      // so retries and start/success analytics share one correlation ID.
      const canonicalAttemptId = result.checkoutAttemptId ?? checkoutAttemptId;
      if (bundleId) {
        bundleAttemptRef.current = { bundleId, attemptId: canonicalAttemptId };
      }

      if (result.url) {
        captureAuthenticatedEvent(
          PAID_FUNNEL_EVENTS.addCreditCheckoutStarted,
          paidFunnelProperties({
            checkout_attempt_id: canonicalAttemptId,
            checkout_type: "extra_usage_purchase",
            surface: "extra_usage_settings",
            source: "buy_extra_usage_dialog",
            amount_dollars: paidDollars,
            credit_amount_dollars: amountDollars,
            discount_dollars: amountDollars - paidDollars,
            bundle_id: bundleId,
            stripe_checkout_session_id: result.checkoutSessionId,
            ...(result.bundleCap && bundleCapAnalytics(result.bundleCap)),
            ...(result.reservationReused && {
              bundle_reservation_reused: true,
            }),
          }),
        );
        window.location.href = result.url;
      } else {
        if (
          result.errorCode === "bundle_cap_exceeded" ||
          result.errorCode === "bundle_cap_unavailable"
        ) {
          captureAuthenticatedEvent("extra_usage_bundle_cap_blocked", {
            surface: "extra_usage_settings",
            checkout_attempt_id: canonicalAttemptId,
            bundle_id: bundleId,
            amount_dollars: paidDollars,
            credit_amount_dollars: amountDollars,
            reason: result.errorCode,
            ...(result.bundleCap && bundleCapAnalytics(result.bundleCap)),
          });
        }
        // A non-retryable answer ends this attempt; ambiguous ones keep it.
        if (bundleId && result.retryable !== true) {
          bundleAttemptRef.current = null;
        }
        toast.error(result.error || "Failed to create checkout session");
      }
    } catch (error) {
      console.error("Failed to purchase credits:", error);
      toast.error("Failed to purchase credits");
    } finally {
      setIsPurchasing(false);
    }
  };

  // Save auto-reload settings from dialog
  const handleSaveAutoReload = async (
    thresholdDollars: number,
    amountDollars: number,
  ) => {
    setIsSavingSettings(true);
    try {
      await updateExtraUsageSettings({
        autoReloadEnabled: true,
        autoReloadThresholdDollars: thresholdDollars,
        autoReloadAmountDollars: amountDollars,
      });
      toast.success("Auto-reload enabled");
      setShowAutoReloadDialog(false);
    } catch (error) {
      console.error("Failed to save auto-reload settings:", error);
      toast.error("Failed to save auto-reload settings");
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Turn off auto-reload from dialog
  const handleTurnOffAutoReload = async () => {
    setIsSavingSettings(true);
    try {
      await updateExtraUsageSettings({ autoReloadEnabled: false });
      toast.success("Auto-reload disabled");
      setShowAutoReloadDialog(false);
    } catch (error) {
      console.error("Failed to turn off auto-reload:", error);
      toast.error("Failed to turn off auto-reload");
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Save monthly spending limit handler
  const handleSaveSpendingLimit = async (limitDollars: number | null) => {
    setIsSavingSettings(true);
    try {
      await updateExtraUsageSettings({
        monthlyCapDollars: limitDollars,
      });
      toast.success(
        limitDollars === null
          ? "Spending limit removed"
          : "Spending limit updated",
      );
      setShowSpendingLimitDialog(false);
    } catch (error) {
      console.error("Failed to save spending limit:", error);
      toast.error("Failed to update spending limit");
    } finally {
      setIsSavingSettings(false);
    }
  };

  const balanceDollars = extraUsageSettings?.balanceDollars ?? 0;
  const autoReloadEnabled = extraUsageSettings?.autoReloadEnabled ?? false;
  const autoReloadDisabledReason = extraUsageSettings?.autoReloadDisabledReason;
  const monthlyCapDollars = extraUsageSettings?.monthlyCapDollars;
  const monthlySpentDollars = extraUsageSettings?.monthlySpentDollars ?? 0;
  const recommendedPurchaseAmountDollars =
    getRecommendedExtraUsagePurchaseAmount(
      getApproximateWeeklyExtraUsageSpend(
        extraUsageSettings?.monthlySpentDollars,
      ),
    );
  const effectiveCapDollars = monthlyCapDollars;

  useEffect(() => {
    if (capturedBuyCtaImpressionRef.current) {
      return;
    }

    capturedBuyCtaImpressionRef.current = true;
    captureAddCreditCtaImpression({
      surface: "extra_usage_settings",
      source: "current_balance_row",
      cta_text: "Buy credit",
    });
  }, []);

  // Get color class based on usage percentage (matches UsageTab)
  const getUsageColorClass = (percentage: number): string => {
    if (percentage >= 90) return "bg-red-500";
    if (percentage >= 70) return "bg-orange-500";
    return "bg-blue-500";
  };

  return (
    <>
      <section
        data-testid="extra-usage-section"
        className="flex flex-col gap-6"
      >
        {/* Toggle Row */}
        <div className="w-full min-w-0 flex flex-row gap-x-8 gap-y-3 justify-between items-center">
          <div className="w-full min-w-0 flex flex-row gap-4 items-center">
            <div className="flex flex-col gap-1.5 min-w-0">
              <p className="text-sm">
                Turn on extra usage to keep using HackerAI if you hit a limit.{" "}
                <a
                  href="https://help.hackerai.co/en/articles/13455916-extra-usage-for-paid-hackerai-plans"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline underline underline-offset-[3px] text-muted-foreground hover:text-foreground"
                  aria-label="Learn more about extra usage"
                >
                  Learn more
                </a>
              </p>
            </div>
          </div>
          <Switch
            checked={userCustomization?.extra_usage_enabled ?? false}
            onCheckedChange={handleToggleExtraUsage}
            disabled={isTogglingExtraUsage}
            aria-label="Toggle extra usage"
          />
        </div>

        <div className="space-y-2">
          {/* Current Balance Row */}
          <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center flex-wrap">
            <div className="flex flex-col gap-1.5 min-w-0">
              <p className="text-sm">
                {extraUsageSettings ? `$${balanceDollars.toFixed(2)}` : "—"}
              </p>
              <p className="text-sm text-muted-foreground">Current balance</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                captureAddCreditCtaClick({
                  surface: "extra_usage_settings",
                  source: "current_balance_row",
                  cta_text: "Buy credit",
                });
                void refreshBundleCapOnOpen();
                setShowBuyDialog(true);
              }}
              disabled={isPurchasing}
              className="min-w-[5rem]"
              aria-describedby={bundlesEnabled ? bundleSavingsId : undefined}
            >
              Buy credit
            </Button>
          </div>
          {bundlesEnabled && (
            <p id={bundleSavingsId} className="text-sm text-muted-foreground">
              Buy more credit, save up to 30%.
            </p>
          )}
        </div>

        {/* Enabled State - Show additional controls */}
        {userCustomization?.extra_usage_enabled && (
          <>
            {/* Monthly Spending Progress */}
            {effectiveCapDollars != null && effectiveCapDollars > 0 && (
              <div className="w-full flex flex-col gap-2">
                <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center flex-wrap">
                  <div className="flex flex-col gap-1.5 min-w-0">
                    <p className="text-sm">
                      ${monthlySpentDollars.toFixed(2)} spent
                    </p>
                    <p className="text-sm text-muted-foreground whitespace-nowrap">
                      Resets{" "}
                      {new Date(
                        new Date().getFullYear(),
                        new Date().getMonth() + 1,
                        1,
                      ).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 md:flex-1 md:max-w-xl">
                    <div className="flex-1">
                      <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full transition-all duration-500 ${getUsageColorClass((monthlySpentDollars / effectiveCapDollars) * 100)}`}
                          style={{
                            width: `${Math.min(100, (monthlySpentDollars / effectiveCapDollars) * 100)}%`,
                          }}
                        />
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground whitespace-nowrap text-right">
                      {Math.min(
                        100,
                        Math.round(
                          (monthlySpentDollars / effectiveCapDollars) * 100,
                        ),
                      )}
                      % used
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Monthly Spending Limit Row */}
            <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center">
              <div className="flex flex-col gap-1.5 min-w-0">
                <p className="text-sm">
                  {effectiveCapDollars != null
                    ? `$${effectiveCapDollars.toFixed(2)}`
                    : "Unlimited"}
                </p>
                <p className="text-sm text-muted-foreground">
                  Monthly spending limit
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSpendingLimitDialog(true)}
                disabled={isSavingSettings}
                className="min-w-[5rem]"
                aria-label="Adjust spending limit"
                tabIndex={0}
              >
                Adjust
              </Button>
            </div>

            <div className="w-full flex items-center justify-between gap-4">
              <div className="space-y-1.5 min-w-0">
                <p className="text-sm">Auto-reload</p>
                <p className="text-sm text-muted-foreground">
                  {autoReloadEnabled ? "On" : "Off"}
                </p>
                {!autoReloadEnabled && autoReloadDisabledReason && (
                  <AutoReloadDisabledAlert reason={autoReloadDisabledReason} />
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAutoReloadDialog(true)}
                disabled={isSavingSettings}
                aria-label="Configure auto-reload"
              >
                Configure
              </Button>
            </div>
          </>
        )}
      </section>

      {/* Dialogs */}
      <TurnOffExtraUsageDialog
        open={showTurnOffDialog}
        onOpenChange={setShowTurnOffDialog}
        onConfirm={handleConfirmTurnOff}
        isLoading={isTogglingExtraUsage}
      />

      <BuyExtraUsageDialog
        bundlesEnabled={bundlesEnabled}
        bundleCap={bundleCapStatus ?? undefined}
        open={showBuyDialog}
        onOpenChange={setShowBuyDialog}
        onPurchase={handlePurchaseCredits}
        isLoading={isPurchasing}
        recommendedAmountDollars={recommendedPurchaseAmountDollars}
      />

      <AdjustSpendingLimitDialog
        open={showSpendingLimitDialog}
        onOpenChange={setShowSpendingLimitDialog}
        onSave={handleSaveSpendingLimit}
        isLoading={isSavingSettings}
        currentLimitDollars={monthlyCapDollars ?? null}
      />

      <AutoReloadDialog
        open={showAutoReloadDialog}
        onOpenChange={setShowAutoReloadDialog}
        onSave={handleSaveAutoReload}
        onTurnOff={handleTurnOffAutoReload}
        onCancel={() => setShowAutoReloadDialog(false)}
        isLoading={isSavingSettings}
        isEnabled={autoReloadEnabled}
        currentThresholdDollars={
          extraUsageSettings?.autoReloadThresholdDollars ?? null
        }
        currentAmountDollars={
          extraUsageSettings?.autoReloadAmountDollars ?? null
        }
      />
    </>
  );
};

export { ExtraUsageSection };
