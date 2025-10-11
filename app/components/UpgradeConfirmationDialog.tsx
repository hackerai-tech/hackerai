"use client";

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { X } from "lucide-react";
import { Loader2 } from "lucide-react";

interface UpgradeConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  planName: string;
  price: number;
  targetPlan: string;
}

// Safely validate and format unix seconds into a display date
const isValidUnix = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const formatUnixDate = (ts?: number) =>
  isValidUnix(ts) ? new Date(ts * 1000).toLocaleDateString() : "";

interface SubscriptionDetails {
  paymentMethod: string;
  currentPlan: string;
  proratedAmount: number;
  proratedCredit: number;
  totalDue: number;
  currentPeriodStart?: number;
  currentPeriodEnd?: number;
  nextInvoiceDate?: number;
  nextInvoiceAmount?: number;
}

const UpgradeConfirmationDialog: React.FC<UpgradeConfirmationDialogProps> = ({
  isOpen,
  onClose,
  planName,
  price,
  targetPlan,
}) => {
  const [details, setDetails] = useState<SubscriptionDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const fetchDetails = async () => {
      if (!isOpen) return;

      setLoadingDetails(true);
      try {
        // Single API call: preview + current details in one response
        const previewRes = await fetch("/api/subscription-details", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ plan: targetPlan, confirm: false }),
        });

        if (!previewRes.ok) {
          throw new Error("Failed to calculate upgrade preview");
        }
        const previewData = await previewRes.json();

        setDetails({
          paymentMethod: previewData.paymentMethod,
          currentPlan: previewData.currentPlan,
          proratedAmount: previewData.proratedAmount ?? price,
          proratedCredit: previewData.proratedCredit,
          totalDue: previewData.totalDue,
          // @ts-expect-error - backend may not send this on older versions
          additionalCredit: previewData.additionalCredit || 0,
          currentPeriodStart: previewData.currentPeriodStart,
          currentPeriodEnd: previewData.currentPeriodEnd,
          nextInvoiceDate: previewData.nextInvoiceDate,
          nextInvoiceAmount: previewData.nextInvoiceAmount,
        });
      } catch (error) {
        console.error("Error fetching subscription details:", error);
        // Set fallback values
        setDetails({
          paymentMethod: "Payment method on file",
          currentPlan: "current",
          proratedAmount: price,
          proratedCredit: 0,
          totalDue: price,
        });
      } finally {
        setLoadingDetails(false);
      }
    };

    fetchDetails();
  }, [isOpen, targetPlan, price]);

  const handleConfirmPayment = async () => {
    setConfirming(true);
    try {
      const response = await fetch("/api/subscription-details", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ plan: targetPlan, confirm: true }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to update subscription");
      }

      const result = await response.json();
      console.log("Subscription updated:", result);

      // Close dialog
      onClose();

      // Redirect with refresh=entitlements to trigger entitlement sync
      setTimeout(() => {
        const url = new URL(window.location.href);
        url.searchParams.set("refresh", "entitlements");
        window.location.href = url.toString();
      }, 500);
    } catch (error) {
      console.error("Error confirming payment:", error);
      alert(
        error instanceof Error
          ? error.message
          : "Failed to update subscription. Please try again.",
      );
    } finally {
      setConfirming(false);
    }
  };

  const proratedCredit = details?.proratedCredit || 0;
  const additionalCredit = (details as any)?.additionalCredit || 0;
  const totalDue = details?.totalDue ?? price;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent
        className="!max-w-[600px] !w-[90vw] sm:!w-full !max-h-[90vh] overflow-y-auto"
        showCloseButton={false}
      >
        <div className="flex items-center justify-between mb-6">
          <DialogTitle className="text-2xl font-semibold">
            Confirm plan changes
          </DialogTitle>
          <button
            onClick={onClose}
            className="text-foreground opacity-50 transition hover:opacity-75"
            aria-label="Close dialog"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="space-y-6">
          {loadingDetails ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Plan Details */}
              <div className="flex items-center justify-between pb-4 border-b">
                <div>
                  <div className="text-lg font-medium">
                    HackerAI {planName} subscription
                  </div>
                  <div className="text-sm text-muted-foreground mt-1">
                    Prorated charge for remaining time in your current billing
                    cycle.
                  </div>
                  {isValidUnix(details?.currentPeriodStart) &&
                    isValidUnix(details?.currentPeriodEnd) && (
                      <div className="text-xs text-muted-foreground mt-1">
                        Current period:{" "}
                        {formatUnixDate(details.currentPeriodStart)} –{" "}
                        {formatUnixDate(details.currentPeriodEnd)}
                      </div>
                    )}
                </div>
                <div className="text-lg font-semibold">
                  ${(details?.proratedAmount ?? price).toFixed(2)}
                </div>
              </div>

              {/* Adjustment - only show if there's a prorated credit */}
              {proratedCredit > 0 && (
                <div className="flex items-start justify-between pb-4 border-b">
                  <div>
                    <div className="text-lg font-medium">Proration credit</div>
                    <div className="text-sm text-muted-foreground mt-1">
                      Credit for unused time on your{" "}
                      {details?.currentPlan || "current"} plan
                    </div>
                  </div>
                  <div className="text-lg font-semibold text-green-600">
                    -${proratedCredit.toFixed(2)}
                  </div>
                </div>
              )}

              {/* Additional credit to balance */}
              {additionalCredit > 0 && (
                <div className="flex items-start justify-between pb-4 border-b">
                  <div>
                    <div className="text-lg font-medium">Credit to balance</div>
                    <div className="text-sm text-muted-foreground mt-1">
                      Excess credit will be added to your account balance
                    </div>
                  </div>
                  <div className="text-lg font-semibold text-green-600">
                    -${additionalCredit.toFixed(2)}
                  </div>
                </div>
              )}

              {/* Total */}
              <div className="flex items-center justify-between pb-6 border-b">
                <div className="text-xl font-semibold">Total due today</div>
                <div className="text-xl font-semibold">
                  ${totalDue.toFixed(2)}
                </div>
              </div>

              {/* Next Invoice Estimate */}
              {isValidUnix(details?.nextInvoiceDate) &&
                typeof details?.nextInvoiceAmount === "number" && (
                  <div className="flex items-center justify-between pb-6 border-b">
                    <div>
                      <div className="text-base font-medium">
                        Next invoice on{" "}
                        {formatUnixDate(details.nextInvoiceDate)}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Estimate; subject to changes to your account balance or
                        usage.
                      </div>
                    </div>
                    <div className="text-base font-semibold">
                      ${Number(details.nextInvoiceAmount).toFixed(2)}
                    </div>
                  </div>
                )}

              {/* Payment Method */}
              {details?.paymentMethod && (
                <div className="flex items-center justify-between pb-6 border-b">
                  <div className="text-base font-medium">Payment Method</div>
                  <div className="text-base">{details.paymentMethod}</div>
                </div>
              )}
            </>
          )}

          {/* Action Buttons */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <Button
              variant="outline"
              size="lg"
              onClick={onClose}
              disabled={confirming || loadingDetails}
              className="px-8"
            >
              Cancel
            </Button>
            <Button
              variant="default"
              size="lg"
              onClick={handleConfirmPayment}
              disabled={confirming || loadingDetails}
              className="px-8"
            >
              {confirming ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Processing...
                </>
              ) : (
                "Pay now"
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default UpgradeConfirmationDialog;
