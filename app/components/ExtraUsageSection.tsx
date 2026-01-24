"use client";

import { useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import {
  TurnOffExtraUsageDialog,
  BuyExtraUsageDialog,
  AdjustSpendingLimitDialog,
  AutoReloadDialog,
} from "@/app/components/extra-usage";

const ExtraUsageSection = () => {
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

  // Loading states
  const [isTogglingExtraUsage, setIsTogglingExtraUsage] = useState(false);
  const [isPurchasing, setIsPurchasing] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);

  // Dialog states
  const [showTurnOffDialog, setShowTurnOffDialog] = useState(false);
  const [showBuyDialog, setShowBuyDialog] = useState(false);
  const [showSpendingLimitDialog, setShowSpendingLimitDialog] = useState(false);
  const [showAutoReloadDialog, setShowAutoReloadDialog] = useState(false);

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
  const handlePurchaseCredits = async (amountDollars: number) => {
    setIsPurchasing(true);
    try {
      const result = await createPurchaseSession({
        amountDollars,
        baseUrl: window.location.origin,
      });

      if (result.url) {
        window.location.href = result.url;
      } else {
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
        limitDollars ? "Spending limit updated" : "Spending limit removed",
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
  const monthlyCapDollars = extraUsageSettings?.monthlyCapDollars;
  const monthlySpentDollars = extraUsageSettings?.monthlySpentDollars ?? 0;

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
        className="flex flex-col gap-6 border-t pt-6 mt-6"
      >
        <h2 className="font-semibold text-base">Extra usage</h2>

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

        {/* Enabled State - Show additional controls */}
        {userCustomization?.extra_usage_enabled && (
          <>
            {/* Monthly Spending Progress */}
            {monthlyCapDollars && monthlyCapDollars > 0 && (
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
                        className={`h-full transition-all duration-500 ${getUsageColorClass((monthlySpentDollars / monthlyCapDollars) * 100)}`}
                        style={{
                          width: `${Math.min(100, (monthlySpentDollars / monthlyCapDollars) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground whitespace-nowrap text-right">
                    {Math.min(
                      100,
                      Math.round(
                        (monthlySpentDollars / monthlyCapDollars) * 100,
                      ),
                    )}
                    % used
                  </p>
                </div>
              </div>
            )}

            {/* Monthly Spending Limit Row */}
            <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center">
              <div className="flex flex-col gap-1.5 min-w-0">
                <p className="text-sm">
                  {monthlyCapDollars
                    ? `$${monthlyCapDollars.toFixed(2)}`
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

            {/* Current Balance Row */}
            <div className="w-full flex flex-row gap-x-8 gap-y-3 justify-between items-center flex-wrap">
              <div className="flex flex-col gap-1.5 min-w-0">
                <p className="text-sm">${balanceDollars.toFixed(2)}</p>
                <p className="text-sm text-muted-foreground whitespace-nowrap">
                  Current balance
                  <span className="mx-1">·</span>
                  <button
                    type="button"
                    onClick={() => setShowAutoReloadDialog(true)}
                    className={
                      autoReloadEnabled
                        ? "text-green-500 underline hover:text-green-400"
                        : "text-red-500 underline hover:text-red-400"
                    }
                    aria-label="Configure auto-reload"
                    tabIndex={0}
                  >
                    Auto-reload {autoReloadEnabled ? "on" : "off"}
                  </button>
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowBuyDialog(true)}
                disabled={isPurchasing}
                className="min-w-[5rem]"
                aria-label="Buy extra usage"
                tabIndex={0}
              >
                Buy extra usage
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
        open={showBuyDialog}
        onOpenChange={setShowBuyDialog}
        onPurchase={handlePurchaseCredits}
        isLoading={isPurchasing}
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
