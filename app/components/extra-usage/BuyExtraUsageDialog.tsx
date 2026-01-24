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
};

/** Format card brand name for display */
const formatCardBrand = (brand: string | null): string => {
  if (!brand) return "Card";
  return brand.charAt(0).toUpperCase() + brand.slice(1).replace(/_/g, " ");
};

const MAX_AMOUNT = 999_999;

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
};

const BuyExtraUsageDialogContent = ({
  onPurchase,
  isLoading,
  onClose,
}: ContentProps) => {
  const [purchaseAmount, setPurchaseAmount] = useState<string>("5");
  const [paymentMethod, setPaymentMethod] = useState<{
    hasPaymentMethod: boolean;
    last4: string | null;
    brand: string | null;
  } | null>(null);
  const [loadingPaymentMethod, setLoadingPaymentMethod] = useState(true);

  const createBillingPortalSession = useAction(
    api.extraUsageActions.createBillingPortalSession,
  );
  const getPaymentStatus = useAction(api.extraUsageActions.getPaymentStatus);

  // Fetch payment method on mount
  useEffect(() => {
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
  }, [getPaymentStatus]);

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
    !isNaN(parsedAmount) && parsedAmount >= 5 && parsedAmount <= MAX_AMOUNT;
  const showMinAmountError =
    purchaseAmount !== "" && !isNaN(parsedAmount) && parsedAmount < 5;
  const showMaxAmountError =
    purchaseAmount !== "" && !isNaN(parsedAmount) && parsedAmount > MAX_AMOUNT;

  const handlePurchase = async () => {
    if (!isValidAmount) return;
    await onPurchase(parsedAmount);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Buy extra usage</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-5 pt-4">
        <div>
          <label className="block text-muted-foreground text-sm mb-3">
            Get extra usage to keep using HackerAI when you hit a limit.
          </label>
          <Input
            placeholder="$5"
            className="w-full"
            type="text"
            value={`$${formatWithCommas(purchaseAmount)}`}
            onChange={(e) => {
              // Remove $ and commas, keep only digits (whole dollars only)
              const val = e.target.value.replace(/[^0-9]/g, "");
              setPurchaseAmount(val);
            }}
            aria-label="Purchase amount"
          />
          {showMinAmountError && (
            <p className="text-sm text-red-500 mt-2">Minimum amount is $5</p>
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
            <span>Extra usage</span>
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
              {loadingPaymentMethod ? (
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
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label="Edit payment method"
                tabIndex={0}
                onClick={handleEditPaymentMethod}
              >
                <Pencil className="h-4 w-4" />
              </button>
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
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

export { BuyExtraUsageDialog };
