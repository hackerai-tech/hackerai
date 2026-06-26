"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useGlobalState } from "@/app/contexts/GlobalState";
import cancelSubscriptionAction from "@/lib/actions/cancel-subscription";
import { toast } from "sonner";
import {
  CheckCircle2,
  Heart,
  Loader2,
  LockKeyhole,
  X as XIcon,
} from "lucide-react";
import {
  proFeatures,
  proPlusFeatures,
  ultraFeatures,
  teamFeatures,
} from "@/lib/pricing/features";
import type { SubscriptionTier } from "@/types";
import {
  CANCELLATION_REASON_OPTIONS,
  type CancellationReasonCategory,
} from "@/lib/billing/cancellation-reasons";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { cn } from "@/lib/utils";

type CancelSubscriptionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type CancellationResult = {
  currentPeriodEnd?: number;
  alreadyScheduled?: boolean;
};

type CancellationStep = "feedback" | "confirm";

const reasonOptionBadges = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const visibleCancellationReasonValues: CancellationReasonCategory[] = [
  "too_expensive",
  "not_using_enough",
  "missing_feature",
  "hit_usage_limits",
  "too_slow_or_unreliable",
  "other",
];

function getFeaturesForTier(tier: SubscriptionTier) {
  switch (tier) {
    case "ultra":
      return [...proFeatures, ...ultraFeatures];
    case "pro-plus":
      return [...proFeatures, ...proPlusFeatures];
    case "team":
      return [...proFeatures, ...teamFeatures];
    case "pro":
      return proFeatures;
    case "free":
      return [];
    default:
      return proFeatures;
  }
}

function getPlanDisplayName(tier: SubscriptionTier) {
  switch (tier) {
    case "ultra":
      return "Ultra";
    case "pro-plus":
      return "Pro+";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return "Pro";
  }
}

export const CancelSubscriptionDialog = ({
  open,
  onOpenChange,
}: CancelSubscriptionDialogProps) => {
  const { subscription } = useGlobalState();
  const [isProcessing, setIsProcessing] = useState(false);
  const [reasonCategory, setReasonCategory] = useState<
    CancellationReasonCategory | ""
  >("");
  const [reasonDetails, setReasonDetails] = useState("");
  const [showValidation, setShowValidation] = useState(false);
  const [cancellationResult, setCancellationResult] =
    useState<CancellationResult | null>(null);
  const [step, setStep] = useState<CancellationStep>("feedback");
  const openRef = useRef(open);
  const wasOpenRef = useRef(false);
  const requestIdRef = useRef(0);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      openRef.current = nextOpen;
      if (!nextOpen) {
        requestIdRef.current += 1;
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange],
  );

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    openRef.current = open;
    wasOpenRef.current = open;

    if (!open) {
      requestIdRef.current += 1;
      setReasonCategory("");
      setReasonDetails("");
      setShowValidation(false);
      setIsProcessing(false);
      setCancellationResult(null);
      setStep("feedback");
      return;
    }

    if (wasOpen) {
      return;
    }

    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.cancellationStarted,
      paidFunnelProperties({
        subscription_tier: subscription,
        surface: "cancel_subscription_dialog",
        source: "account_settings",
      }),
    );
  }, [open, subscription]);

  const handleContinueToConfirmation = useCallback(() => {
    const trimmedReasonDetails = reasonDetails.trim();
    if (!reasonCategory || !trimmedReasonDetails) {
      setShowValidation(true);
      return;
    }

    setShowValidation(false);
    setStep("confirm");
  }, [reasonCategory, reasonDetails]);

  const handleCancelSubscription = useCallback(async () => {
    const trimmedReasonDetails = reasonDetails.trim();
    if (!reasonCategory || !trimmedReasonDetails) {
      setShowValidation(true);
      setStep("feedback");
      return;
    }

    setIsProcessing(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const result = await cancelSubscriptionAction({
        cancellationReason: {
          reasonCategory,
          reasonDetails: trimmedReasonDetails,
        },
      });
      if (!openRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setCancellationResult({
        currentPeriodEnd: result.currentPeriodEnd,
        alreadyScheduled: result.alreadyScheduled,
      });
      toast.success(
        result.alreadyScheduled
          ? "Subscription already scheduled to cancel"
          : "Subscription scheduled to cancel",
      );
    } catch (error) {
      if (!openRef.current || requestIdRef.current !== requestId) {
        return;
      }
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to cancel subscription",
      );
    } finally {
      if (openRef.current && requestIdRef.current === requestId) {
        setIsProcessing(false);
      }
    }
  }, [reasonCategory, reasonDetails]);

  const handleReasonCategoryChange = useCallback(
    (value: string) => {
      const nextReasonCategory = value as CancellationReasonCategory;
      setReasonCategory(nextReasonCategory);
      setShowValidation(false);
      captureAuthenticatedEvent(
        PAID_FUNNEL_EVENTS.cancellationReasonSelected,
        paidFunnelProperties({
          subscription_tier: subscription,
          reason_category: nextReasonCategory,
          surface: "cancel_subscription_dialog",
          source: "account_settings",
        }),
      );
    },
    [subscription],
  );

  const handleBack = useCallback(() => {
    if (step === "confirm") {
      setStep("feedback");
      return;
    }

    handleOpenChange(false);
  }, [handleOpenChange, step]);

  const features = getFeaturesForTier(subscription);
  const planName = getPlanDisplayName(subscription);
  const trimmedReasonDetails = reasonDetails.trim();
  const hasRequiredReason = Boolean(reasonCategory && trimmedReasonDetails);
  const detailsMissing = showValidation && !trimmedReasonDetails;
  const categoryMissing = showValidation && !reasonCategory;
  const periodEndDate = cancellationResult?.currentPeriodEnd
    ? new Intl.DateTimeFormat(undefined, {
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(new Date(cancellationResult.currentPeriodEnd))
    : null;
  const isConfirmStep = step === "confirm";
  const StepIcon = cancellationResult
    ? CheckCircle2
    : isConfirmStep
      ? LockKeyhole
      : Heart;
  const stepLabel = cancellationResult
    ? "Cancellation scheduled"
    : isConfirmStep
      ? "Final confirmation"
      : "Your feedback";
  const selectedReasonLabel = CANCELLATION_REASON_OPTIONS.find(
    (option) => option.value === reasonCategory,
  )?.label;
  const visibleCancellationReasonOptions = CANCELLATION_REASON_OPTIONS.filter(
    (option) => visibleCancellationReasonValues.includes(option.value),
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[90vh] flex-col overflow-hidden p-0 sm:max-w-[560px]"
      >
        <div className="flex items-center justify-between border-b border-border bg-muted/40 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3 text-sm font-semibold text-premium-text">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-premium-bg text-premium-text">
              <StepIcon className="size-4" aria-hidden="true" />
            </span>
            <span className="truncate">{stepLabel}</span>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={() => handleOpenChange(false)}
            disabled={isProcessing}
            className="flex size-8 shrink-0 items-center justify-center rounded-md bg-premium-bg text-premium-text transition-colors hover:bg-premium-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <XIcon className="size-4" aria-hidden="true" />
          </button>
        </div>

        {cancellationResult ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-3 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  Cancellation scheduled
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  {periodEndDate
                    ? `You'll keep your ${planName} plan until ${periodEndDate}.`
                    : `You'll keep your ${planName} plan until the end of your current billing period.`}
                </DialogDescription>
              </DialogHeader>
            </div>
            <DialogFooter className="border-t border-border px-6 py-5 sm:px-8">
              <Button
                className="h-11 w-full sm:w-44"
                onClick={() => handleOpenChange(false)}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : isConfirmStep ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-4 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  Are you sure you want to cancel?
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  {`You'll keep your ${planName} plan until the end of your current billing period, then lose access to these benefits.`}
                </DialogDescription>
              </DialogHeader>

              <div className="mt-7 rounded-lg border border-border bg-muted/40 p-5">
                <ul className="space-y-2 text-sm leading-6 text-foreground">
                  {features.map((feature, index) => (
                    <li key={index} className="flex gap-3">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground" />
                      <span>{feature.text}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-5 rounded-md border border-border bg-background/60 p-3 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">Reason:</span>{" "}
                {selectedReasonLabel}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <Button
                variant="destructive"
                onClick={handleCancelSubscription}
                disabled={isProcessing}
                className="h-11 w-full sm:w-48"
              >
                {isProcessing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Confirm & Cancel"
                )}
              </Button>
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={isProcessing}
                className="h-11 w-full sm:w-36"
              >
                Back
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-3 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  Before you go...
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  Could you share why you&apos;re leaving so we can improve?
                </DialogDescription>
              </DialogHeader>

              <div
                className="mt-7 space-y-2"
                role="radiogroup"
                aria-label="Main cancellation reason"
                aria-invalid={categoryMissing}
              >
                {visibleCancellationReasonOptions.map((option, index) => {
                  const isSelected = reasonCategory === option.value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      onClick={() => handleReasonCategoryChange(option.value)}
                      disabled={isProcessing}
                      className={cn(
                        "flex h-14 w-full items-center gap-4 rounded-md border px-4 text-left text-base font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
                        isSelected
                          ? "border-violet-500/70 bg-premium-bg text-foreground"
                          : "border-border bg-muted/40 text-foreground hover:bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold",
                          isSelected
                            ? "bg-premium-text text-background"
                            : "bg-premium-bg text-premium-text",
                        )}
                      >
                        {reasonOptionBadges[index]}
                      </span>
                      <span className="min-w-0 truncate">{option.label}</span>
                    </button>
                  );
                })}
              </div>
              {categoryMissing ? (
                <p className="mt-2 text-xs text-destructive">
                  Please select a main reason.
                </p>
              ) : null}

              <div className="mt-6 space-y-2">
                <Label htmlFor="cancellation-reason-details">
                  Tell us what happened
                </Label>
                <Textarea
                  id="cancellation-reason-details"
                  value={reasonDetails}
                  onChange={(event) => {
                    setReasonDetails(event.target.value);
                    setShowValidation(false);
                  }}
                  maxLength={2000}
                  disabled={isProcessing}
                  aria-invalid={detailsMissing}
                  placeholder="A short note is required before continuing."
                  className="min-h-28 resize-none bg-muted/30"
                />
                {detailsMissing ? (
                  <p className="text-xs text-destructive">
                    Please write a cancellation reason.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <Button
                onClick={handleContinueToConfirmation}
                disabled={isProcessing}
                className={cn(
                  "h-11 w-full sm:w-36",
                  !hasRequiredReason && "opacity-60",
                )}
              >
                Next
              </Button>
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={isProcessing}
                className="h-11 w-full sm:w-36"
              >
                Back
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default CancelSubscriptionDialog;
