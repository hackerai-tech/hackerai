"use client";

import { useState, useEffect } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CreditCard, Pencil, Wallet } from "lucide-react";
import { toast } from "sonner";

type BuyExtraUsageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPurchase: (amountDollars: number) => Promise<void>;
  isLoading: boolean;
  title?: string;
  description?: string;
  lineItemLabel?: string;
  paymentMethodMode?: "personal" | "checkout";
  recommendedAmountDollars?: number;
};

/** Format card brand name for display */
const formatCardBrand = (brand: string | null): string => {
  if (!brand) return "Card";
  return brand.charAt(0).toUpperCase() + brand.slice(1).replace(/_/g, " ");
};

const MAX_AMOUNT = 999_999;
const PRESET_AMOUNTS = [15, 30, 50] as const;
const DAY_MS = 24 * 60 * 60 * 1_000;

export const getApproximateWeeklyExtraUsageSpend = (
  monthlySpentDollars: number | undefined,
  now = Date.now(),
): number | undefined => {
  if (
    monthlySpentDollars === undefined ||
    !Number.isFinite(monthlySpentDollars) ||
    monthlySpentDollars <= 0
  ) {
    return undefined;
  }

  const date = new Date(now);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  const elapsedDays = Math.max(1, (now - monthStart) / DAY_MS);
  return (monthlySpentDollars / elapsedDays) * 7;
};

export const getRecommendedExtraUsagePurchaseAmount = (
  recentExtraUsageSpendDollars: number | undefined,
): number | undefined => {
  if (
    recentExtraUsageSpendDollars === undefined ||
    !Number.isFinite(recentExtraUsageSpendDollars) ||
    recentExtraUsageSpendDollars <= 0
  ) {
    return undefined;
  }

  const preset = PRESET_AMOUNTS.find(
    (amount) => amount >= recentExtraUsageSpendDollars,
  );
  if (preset !== undefined) return preset;

  return Math.min(MAX_AMOUNT, Math.ceil(recentExtraUsageSpendDollars / 5) * 5);
};

/** Format number with commas (e.g., 1000 -> 1,000) */
const formatWithCommas = (value: string): string => {
  // Remove existing commas
  const cleanValue = value.replace(/,/g, "");
  // Format with commas (whole dollars only)
  return cleanValue.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

/** Remove commas for parsing */
const removeCommas = (value: string): string => value.replace(/,/g, "");

type ContentProps = {
  onPurchase: (amountDollars: number) => Promise<void>;
  isLoading: boolean;
  onClose: () => void;
  title: string;
  description: string;
  lineItemLabel: string;
  paymentMethodMode: "personal" | "checkout";
  recommendedAmountDollars?: number;
};

const BuyExtraUsageDialogContent = ({
  onPurchase,
  isLoading,
  title,
  description,
  lineItemLabel,
  paymentMethodMode,
  recommendedAmountDollars,
}: ContentProps) => {
  const [purchaseAmountOverride, setPurchaseAmountOverride] = useState<
    string | null
  >(null);
  const purchaseAmount =
    purchaseAmountOverride ?? String(recommendedAmountDollars ?? 15);
  const [paymentMethod, setPaymentMethod] = useState<{
    hasPaymentMethod: boolean;
    last4: string | null;
    brand: string | null;
  } | null>(null);
  const [loadingPaymentMethod, setLoadingPaymentMethod] = useState(
    paymentMethodMode === "personal",
  );

  const createBillingPortalSession = useAction(
    api.extraUsageActions.createBillingPortalSession,
  );
  const getPaymentStatus = useAction(api.extraUsageActions.getPaymentStatus);

  // Fetch payment method on mount
  useEffect(() => {
    if (paymentMethodMode === "checkout") {
      return;
    }

    getPaymentStatus({})
      .then((result) => {
        setPaymentMethod({
          hasPaymentMethod: result.hasPaymentMethod,
          last4: result.paymentMethodLast4,
          brand: result.paymentMethodBrand,
        });
      })
      .catch((err) => {
        console.error("Failed to fetch payment method:", err);
      })
      .finally(() => {
        setLoadingPaymentMethod(false);
      });
  }, [getPaymentStatus, paymentMethodMode]);

  const handleEditPaymentMethod = async () => {
    try {
      const result = await createBillingPortalSession({
        flow: "payment_method",
        baseUrl: window.location.origin,
      });
      if (result.url) {
        window.open(result.url, "_blank", "noopener,noreferrer");
        // Clear cached payment method so it refreshes when user returns
        setPaymentMethod(null);
      } else {
        toast.error(result.error || "Failed to open billing portal");
      }
    } catch {
      toast.error("Failed to open billing portal");
    }
  };

  const parsedAmount = parseInt(removeCommas(purchaseAmount) || "0", 10);
  const isValidAmount =
    !isNaN(parsedAmount) && parsedAmount >= 15 && parsedAmount <= MAX_AMOUNT;
  const showMinAmountError =
    purchaseAmount !== "" && !isNaN(parsedAmount) && parsedAmount < 15;
  const showMaxAmountError =
    purchaseAmount !== "" && !isNaN(parsedAmount) && parsedAmount > MAX_AMOUNT;

  const handlePurchase = async () => {
    if (!isValidAmount) return;
    await onPurchase(parsedAmount);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-5 pt-4">
        <div>
          <p className="text-muted-foreground text-sm mb-3">{description}</p>
          <div className="grid grid-cols-3 gap-2 mb-3">
            {PRESET_AMOUNTS.map((amount) => {
              const isSelected = parsedAmount === amount;
              const isRecommended = recommendedAmountDollars === amount;

              return (
                <Button
                  key={amount}
                  type="button"
                  variant={isSelected ? "default" : "outline"}
                  className="h-auto min-h-11 flex-col gap-0.5 py-2"
                  aria-pressed={isSelected}
                  onClick={() => {
                    setPurchaseAmountOverride(String(amount));
                  }}
                >
                  <span>${amount}</span>
                  {isRecommended && (
                    <span className="text-[10px] font-normal opacity-80">
                      Recommended
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
          {recommendedAmountDollars !== undefined && (
            <p className="text-sm text-muted-foreground mb-3">
              ${formatWithCommas(String(recommendedAmountDollars))} should cover
              approximately your next week.
            </p>
          )}
          <label
            htmlFor="extra-usage-purchase-amount"
            className="block text-sm font-medium mb-2"
          >
            Custom amount
          </label>
          <Input
            id="extra-usage-purchase-amount"
            placeholder="$15"
            className="w-full"
            type="text"
            value={`$${formatWithCommas(purchaseAmount)}`}
            onChange={(e) => {
              // Remove $ and commas, keep only digits (whole dollars only)
              const val = e.target.value.replace(/[^0-9]/g, "");
              setPurchaseAmountOverride(val);
            }}
            aria-label="Purchase amount"
          />
          {showMinAmountError && (
            <p className="text-sm text-red-500 mt-2">Minimum amount is $15</p>
          )}
          {showMaxAmountError && (
            <p className="text-sm text-red-500 mt-2">
              Maximum amount is $999,999
            </p>
          )}
        </div>
        <div className="space-y-2">
          <hr className="mb-5 border-border" />
          <div className="flex justify-between text-sm">
            <span>{lineItemLabel}</span>
            <span>${formatWithCommas(String(parsedAmount))}</span>
          </div>
          <div className="flex justify-between pt-2 text-sm font-medium">
            <span>Total due</span>
            <span>${formatWithCommas(String(parsedAmount))}</span>
          </div>
        </div>
        <div className="mt-2">
          <div className="flex items-center justify-between p-5 border border-border rounded-lg">
            <span className="font-medium text-sm">Payment method</span>
            <div className="flex items-center gap-3">
              {paymentMethodMode === "checkout" ? (
                <p className="text-sm flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  Team billing account
                </p>
              ) : loadingPaymentMethod ? (
                <p className="text-sm text-muted-foreground">Loading...</p>
              ) : paymentMethod?.hasPaymentMethod && paymentMethod.last4 ? (
                <p className="text-sm flex items-center gap-2">
                  <CreditCard className="h-5 w-5" />
                  {formatCardBrand(paymentMethod.brand)} ending in{" "}
                  {paymentMethod.last4}
                </p>
              ) : (
                <p className="text-sm flex items-center gap-2">
                  <Wallet className="h-5 w-5" />
                  Link by Stripe
                </p>
              )}
              {paymentMethodMode === "personal" && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Edit payment method"
                  tabIndex={0}
                  onClick={handleEditPaymentMethod}
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Button
            onClick={handlePurchase}
            disabled={isLoading || !isValidAmount}
            className="w-full h-11"
          >
            {isLoading ? "Processing..." : "Purchase"}
          </Button>
        </div>
      </div>
    </>
  );
};

const BuyExtraUsageDialog = ({
  open,
  onOpenChange,
  onPurchase,
  isLoading,
  title = "Buy extra usage",
  description = "Get extra usage to keep using HackerAI when you hit a limit.",
  lineItemLabel = "Extra usage",
  paymentMethodMode = "personal",
  recommendedAmountDollars,
}: BuyExtraUsageDialogProps) => {
  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange(newOpen);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && (
          <BuyExtraUsageDialogContent
            onPurchase={onPurchase}
            isLoading={isLoading}
            onClose={() => onOpenChange(false)}
            title={title}
            description={description}
            lineItemLabel={lineItemLabel}
            paymentMethodMode={paymentMethodMode}
            recommendedAmountDollars={recommendedAmountDollars}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

export { BuyExtraUsageDialog };
