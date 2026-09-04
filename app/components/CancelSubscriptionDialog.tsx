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
import {
  cancelSubscription,
  getRetentionOffers,
  pauseSubscription,
} from "@/lib/billing/client";
import type {
  PauseSubscriptionResult,
  RetentionOffers,
} from "@/lib/billing/api-types";
import { toast } from "sonner";
import {
  CheckCircle2,
  Heart,
  Loader2,
  LockKeyhole,
  PauseCircle,
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
  CANCELLATION_REASON_SUBCATEGORY_OPTIONS,
  getCancellationReasonSubcategoryOptions,
  type CancellationReasonCategory,
  type CancellationReasonSubcategory,
} from "@/lib/billing/cancellation-reasons";
import {
  PAUSE_DURATION_MONTH_OPTIONS,
  type PauseDurationMonths,
  type RetentionOfferType,
} from "@/lib/billing/retention-offers";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  PAID_FUNNEL_EVENTS,
  paidFunnelProperties,
} from "@/lib/analytics/paid-funnel";
import { cn } from "@/lib/utils";

type CancelSubscriptionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancellationCompleted?: (result: CancellationResult) => void;
  onPauseScheduled?: (result: PauseSubscriptionResult) => void;
};

type CancellationResult = {
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  alreadyScheduled?: boolean;
};

type RetentionOfferResult = { type: "pause"; result: PauseSubscriptionResult };

type CancellationStep = "reason" | "details" | "offer" | "confirm";

const reasonOptionBadges = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const visibleCancellationReasonValues: CancellationReasonCategory[] = [
  "too_expensive",
  "not_using_enough",
  "missing_feature",
  "results_not_good_enough",
  "hit_usage_limits",
  "too_slow_or_unreliable",
  "other",
];

const OFFER_ANALYTICS_CONTEXT = {
  surface: "cancel_subscription_dialog",
  source: "account_settings",
} as const;

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

function formatLongDate(timestamp?: number) {
  if (!timestamp) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp));
}

function pluralizeMonths(months: number) {
  return `${months} month${months === 1 ? "" : "s"}`;
}

function shownOfferTypes(offers: RetentionOffers): RetentionOfferType[] {
  return offers.pause.eligible && offers.pause.options.length > 0
    ? ["pause"]
    : [];
}

export const CancelSubscriptionDialog = ({
  open,
  onOpenChange,
  onCancellationCompleted,
  onPauseScheduled,
}: CancelSubscriptionDialogProps) => {
  const { subscription } = useGlobalState();
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoadingOffers, setIsLoadingOffers] = useState(false);
  const [reasonCategory, setReasonCategory] = useState<
    CancellationReasonCategory | ""
  >("");
  const [reasonSubcategory, setReasonSubcategory] = useState<
    CancellationReasonSubcategory | ""
  >("");
  const [reasonDetails, setReasonDetails] = useState("");
  const [showValidation, setShowValidation] = useState(false);
  const [cancellationResult, setCancellationResult] =
    useState<CancellationResult | null>(null);
  const [offerResult, setOfferResult] = useState<RetentionOfferResult | null>(
    null,
  );
  const [offers, setOffers] = useState<RetentionOffers | null>(null);
  const [selectedPauseMonths, setSelectedPauseMonths] =
    useState<PauseDurationMonths>(1);
  const [step, setStep] = useState<CancellationStep>("reason");
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
      setReasonSubcategory("");
      setReasonDetails("");
      setShowValidation(false);
      setIsProcessing(false);
      setIsLoadingOffers(false);
      setCancellationResult(null);
      setOfferResult(null);
      setOffers(null);
      setSelectedPauseMonths(1);
      setStep("reason");
      return;
    }

    if (wasOpen) {
      return;
    }

    captureAuthenticatedEvent(
      PAID_FUNNEL_EVENTS.cancellationStarted,
      paidFunnelProperties({
        subscription_tier: subscription,
        ...OFFER_ANALYTICS_CONTEXT,
      }),
    );
  }, [open, subscription]);

  const handleContinueToDetails = useCallback(() => {
    if (!reasonCategory) {
      setShowValidation(true);
      return;
    }

    setShowValidation(false);
    setStep("details");
  }, [reasonCategory]);

  const handleContinueToConfirmation = useCallback(async () => {
    const trimmedReasonDetails = reasonDetails.trim();
    if (!reasonCategory) {
      setShowValidation(true);
      setStep("reason");
      return;
    }
    if (!reasonSubcategory || !trimmedReasonDetails) {
      setShowValidation(true);
      return;
    }

    setShowValidation(false);

    if (offers) {
      setStep(shownOfferTypes(offers).length > 0 ? "offer" : "confirm");
      return;
    }

    setIsLoadingOffers(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    let nextOffers: RetentionOffers | null = null;
    try {
      nextOffers = await getRetentionOffers({ reasonCategory });
    } catch {
      // Offers are optional. Fall through to the plain cancellation flow.
      nextOffers = null;
    }
    if (!openRef.current || requestIdRef.current !== requestId) {
      return;
    }
    setIsLoadingOffers(false);

    const offerTypes = nextOffers ? shownOfferTypes(nextOffers) : [];
    if (nextOffers && offerTypes.length > 0) {
      setOffers(nextOffers);
      setStep("offer");
      captureAuthenticatedEvent(
        PAID_FUNNEL_EVENTS.retentionOfferImpressed,
        paidFunnelProperties({
          subscription_tier: subscription,
          reason_category: reasonCategory,
          reason_subcategory: reasonSubcategory,
          offers_shown: offerTypes,
          pause_offered: offerTypes.includes("pause"),
          pause_effective_at: nextOffers.pause.pauseEffectiveAt
            ? new Date(nextOffers.pause.pauseEffectiveAt).toISOString()
            : undefined,
          ...OFFER_ANALYTICS_CONTEXT,
        }),
      );
      return;
    }

    setStep("confirm");
  }, [offers, reasonCategory, reasonDetails, reasonSubcategory, subscription]);

  const handleDeclineOffers = useCallback(() => {
    if (offers) {
      captureAuthenticatedEvent(
        PAID_FUNNEL_EVENTS.retentionOfferDeclined,
        paidFunnelProperties({
          subscription_tier: subscription,
          reason_category: reasonCategory,
          reason_subcategory: reasonSubcategory,
          offers_shown: shownOfferTypes(offers),
          ...OFFER_ANALYTICS_CONTEXT,
        }),
      );
    }
    setStep("confirm");
  }, [offers, reasonCategory, reasonSubcategory, subscription]);

  const handleAcceptPause = useCallback(async () => {
    const trimmedReasonDetails = reasonDetails.trim();
    if (!reasonCategory || !reasonSubcategory || !trimmedReasonDetails) {
      setShowValidation(true);
      setStep("details");
      return;
    }

    setIsProcessing(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const result = await pauseSubscription({
        months: selectedPauseMonths,
        cancellationReason: {
          reasonCategory,
          reasonSubcategory,
          reasonDetails: trimmedReasonDetails,
        },
      });
      if (!openRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setOfferResult({ type: "pause", result });
      onPauseScheduled?.(result);
      toast.success(
        result.alreadyScheduled
          ? "Your plan is already scheduled to pause"
          : "Pause scheduled",
      );
    } catch (error) {
      if (!openRef.current || requestIdRef.current !== requestId) {
        return;
      }
      toast.error(
        error instanceof Error ? error.message : "Failed to pause subscription",
      );
    } finally {
      if (openRef.current && requestIdRef.current === requestId) {
        setIsProcessing(false);
      }
    }
  }, [
    onPauseScheduled,
    reasonCategory,
    reasonDetails,
    reasonSubcategory,
    selectedPauseMonths,
  ]);

  const handleCancelSubscription = useCallback(async () => {
    const trimmedReasonDetails = reasonDetails.trim();
    if (!reasonCategory) {
      setShowValidation(true);
      setStep("reason");
      return;
    }
    if (!reasonSubcategory || !trimmedReasonDetails) {
      setShowValidation(true);
      setStep("details");
      return;
    }

    setIsProcessing(true);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const result = await cancelSubscription({
        cancellationReason: {
          reasonCategory,
          reasonSubcategory,
          reasonDetails: trimmedReasonDetails,
        },
      });
      if (!openRef.current || requestIdRef.current !== requestId) {
        return;
      }
      setCancellationResult({
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
        currentPeriodEnd: result.currentPeriodEnd,
        alreadyScheduled: result.alreadyScheduled,
      });
      onCancellationCompleted?.({
        cancelAtPeriodEnd: result.cancelAtPeriodEnd,
        currentPeriodEnd: result.currentPeriodEnd,
        alreadyScheduled: result.alreadyScheduled,
      });
      toast.success(
        result.alreadyScheduled
          ? "Subscription already scheduled to cancel"
          : result.cancelAtPeriodEnd
            ? "Subscription scheduled to cancel"
            : "Subscription canceled. Payment retries stopped.",
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
  }, [
    onCancellationCompleted,
    reasonCategory,
    reasonDetails,
    reasonSubcategory,
  ]);

  const handleReasonCategoryChange = useCallback(
    (value: string) => {
      const nextReasonCategory = value as CancellationReasonCategory;
      setReasonCategory(nextReasonCategory);
      setReasonSubcategory("");
      setOffers(null);
      setShowValidation(false);
      captureAuthenticatedEvent(
        PAID_FUNNEL_EVENTS.cancellationReasonSelected,
        paidFunnelProperties({
          subscription_tier: subscription,
          reason_category: nextReasonCategory,
          ...OFFER_ANALYTICS_CONTEXT,
        }),
      );
    },
    [subscription],
  );

  const handleReasonSubcategoryChange = useCallback(
    (value: string) => {
      if (!reasonCategory) return;

      const nextReasonSubcategory = value as CancellationReasonSubcategory;
      setReasonSubcategory(nextReasonSubcategory);
      setShowValidation(false);
      captureAuthenticatedEvent(
        PAID_FUNNEL_EVENTS.cancellationReasonFollowUpSelected,
        paidFunnelProperties({
          subscription_tier: subscription,
          reason_category: reasonCategory,
          reason_subcategory: nextReasonSubcategory,
          ...OFFER_ANALYTICS_CONTEXT,
        }),
      );
    },
    [reasonCategory, subscription],
  );

  const handleBack = useCallback(() => {
    if (step === "confirm") {
      setStep(
        offers && shownOfferTypes(offers).length > 0 ? "offer" : "details",
      );
      return;
    }
    if (step === "offer") {
      setStep("details");
      return;
    }
    if (step === "details") {
      setStep("reason");
      return;
    }

    handleOpenChange(false);
  }, [handleOpenChange, offers, step]);

  const features = getFeaturesForTier(subscription);
  const planName = getPlanDisplayName(subscription);
  const trimmedReasonDetails = reasonDetails.trim();
  const hasRequiredReason = Boolean(reasonCategory);
  const hasRequiredDetails = Boolean(reasonSubcategory && trimmedReasonDetails);
  const detailsMissing = showValidation && !trimmedReasonDetails;
  const categoryMissing = showValidation && !reasonCategory;
  const subcategoryMissing = showValidation && !reasonSubcategory;
  const periodEndDate = formatLongDate(cancellationResult?.currentPeriodEnd);
  const canceledImmediately = cancellationResult?.cancelAtPeriodEnd === false;
  const isConfirmStep = step === "confirm";
  const isDetailsStep = step === "details";
  const isOfferStep = step === "offer";
  const StepIcon =
    cancellationResult || offerResult
      ? CheckCircle2
      : isConfirmStep
        ? LockKeyhole
        : Heart;
  const stepLabel = cancellationResult
    ? canceledImmediately
      ? "Subscription canceled"
      : "Cancellation scheduled"
    : offerResult
      ? "Pause scheduled"
      : isConfirmStep
        ? "Final confirmation"
        : isOfferStep
          ? "Before you cancel"
          : isDetailsStep
            ? "Your feedback"
            : "Main reason";
  const selectedReasonLabel = CANCELLATION_REASON_OPTIONS.find(
    (option) => option.value === reasonCategory,
  )?.label;
  const selectedReasonSubcategoryLabel =
    CANCELLATION_REASON_SUBCATEGORY_OPTIONS.find(
      (option) => option.value === reasonSubcategory,
    )?.label;
  const visibleCancellationReasonOptions = CANCELLATION_REASON_OPTIONS.filter(
    (option) => visibleCancellationReasonValues.includes(option.value),
  );
  const visibleReasonSubcategoryOptions = reasonCategory
    ? getCancellationReasonSubcategoryOptions(reasonCategory)
    : [];
  const pauseOffer =
    offers?.pause.eligible && offers.pause.options.length > 0
      ? offers.pause
      : null;
  const selectedPauseOption =
    pauseOffer?.options.find(
      (option) => option.months === selectedPauseMonths,
    ) ??
    pauseOffer?.options[0] ??
    null;
  const pauseEffectiveDate = formatLongDate(pauseOffer?.pauseEffectiveAt);
  const pauseResumeDate = formatLongDate(selectedPauseOption?.resumeAt);

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

        {offerResult ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-3 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  Pause scheduled
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  {`Your ${planName} plan stays active until ${
                    formatLongDate(offerResult.result.pauseEffectiveAt) ??
                    "the end of your current billing period"
                  }. Billing then pauses for ${pluralizeMonths(
                    offerResult.result.months,
                  )} and your plan resumes automatically on ${
                    formatLongDate(offerResult.result.resumeAt) ??
                    "the resume date"
                  }. You can resume sooner or cancel the pause from Account settings.`}
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
        ) : cancellationResult ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-3 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  {canceledImmediately
                    ? "Subscription canceled"
                    : "Cancellation scheduled"}
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  {canceledImmediately
                    ? `Your ${planName} subscription is canceled. We won't retry the failed renewal payment.`
                    : periodEndDate
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
        ) : isOfferStep ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-3 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  Before you cancel
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  Take a break instead of starting over later.
                </DialogDescription>
              </DialogHeader>

              <div className="mt-6 space-y-4">
                {pauseOffer ? (
                  <section
                    aria-labelledby="retention-pause-title"
                    className="rounded-lg border border-border bg-muted/40 p-5"
                  >
                    <div className="flex items-start gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-premium-bg text-premium-text">
                        <PauseCircle className="size-5" aria-hidden="true" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3
                          id="retention-pause-title"
                          className="text-lg font-semibold text-foreground"
                        >
                          Pause your plan
                        </h3>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">
                          {pauseEffectiveDate
                            ? `Keep ${planName} until ${pauseEffectiveDate}, then pause billing.`
                            : `Keep ${planName} until the end of your paid period, then pause billing.`}{" "}
                          {pauseResumeDate
                            ? `Your plan resumes automatically on ${pauseResumeDate} with the same price and your saved card. No charges in between.`
                            : "Your plan resumes automatically with the same price and your saved card. No charges in between."}
                        </p>
                      </div>
                    </div>

                    <div
                      className="mt-4 grid grid-cols-3 gap-2"
                      role="radiogroup"
                      aria-label="Pause duration"
                    >
                      {PAUSE_DURATION_MONTH_OPTIONS.map((months) => {
                        const isSelected = selectedPauseMonths === months;
                        const available = pauseOffer.options.some(
                          (option) => option.months === months,
                        );
                        if (!available) return null;

                        return (
                          <button
                            key={months}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            onClick={() => setSelectedPauseMonths(months)}
                            disabled={isProcessing}
                            className={cn(
                              "h-11 rounded-md border text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
                              isSelected
                                ? "border-violet-500/70 bg-premium-bg text-foreground"
                                : "border-border bg-background/60 text-foreground hover:bg-muted",
                            )}
                          >
                            {pluralizeMonths(months)}
                          </button>
                        );
                      })}
                    </div>

                    <Button
                      onClick={handleAcceptPause}
                      disabled={isProcessing}
                      className="mt-4 h-11 w-full"
                    >
                      {isProcessing ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        `Pause for ${pluralizeMonths(selectedPauseMonths)}`
                      )}
                    </Button>
                  </section>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <Button
                variant="ghost"
                onClick={handleDeclineOffers}
                disabled={isProcessing}
                className="h-11 w-full text-muted-foreground sm:w-auto"
              >
                No thanks, continue to cancel
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
        ) : isConfirmStep ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-4 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  Are you sure you want to cancel?
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  {`You'll keep your ${planName} plan through any period you've already paid for. If a renewal payment is overdue, cancellation takes effect immediately and stops further retries.`}
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
                <p>
                  <span className="font-medium text-foreground">Reason:</span>{" "}
                  {selectedReasonLabel}
                </p>
                <p className="mt-1">
                  <span className="font-medium text-foreground">
                    What happened:
                  </span>{" "}
                  {selectedReasonSubcategoryLabel}
                </p>
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
        ) : isDetailsStep ? (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-7 sm:px-8">
              <DialogHeader className="gap-3 text-left sm:text-left">
                <DialogTitle className="text-3xl leading-tight font-semibold sm:text-4xl">
                  Tell us what happened
                </DialogTitle>
                <DialogDescription className="text-base leading-7">
                  A little more detail helps us focus on the right improvement.
                </DialogDescription>
              </DialogHeader>

              <div className="mt-6 rounded-md border border-border bg-muted/40 p-3 text-sm">
                <span className="font-medium text-foreground">
                  Main reason:
                </span>{" "}
                <span className="text-muted-foreground">
                  {selectedReasonLabel}
                </span>
              </div>

              <div className="mt-6 space-y-2">
                <Label id="cancellation-reason-subcategory-label">
                  What best describes what happened?
                </Label>
                <div
                  className="space-y-2"
                  role="radiogroup"
                  aria-labelledby="cancellation-reason-subcategory-label"
                  aria-invalid={subcategoryMissing}
                >
                  {visibleReasonSubcategoryOptions.map((option, index) => {
                    const isSelected = reasonSubcategory === option.value;

                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() =>
                          handleReasonSubcategoryChange(option.value)
                        }
                        disabled={isProcessing || isLoadingOffers}
                        className={cn(
                          "flex min-h-12 w-full items-center gap-3 rounded-md border px-4 py-2.5 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50",
                          isSelected
                            ? "border-violet-500/70 bg-premium-bg text-foreground"
                            : "border-border bg-muted/40 text-foreground hover:bg-muted",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold",
                            isSelected
                              ? "bg-premium-text text-background"
                              : "bg-premium-bg text-premium-text",
                          )}
                        >
                          {index + 1}
                        </span>
                        <span>{option.label}</span>
                      </button>
                    );
                  })}
                </div>
                {subcategoryMissing ? (
                  <p className="text-xs text-destructive">
                    Please select what best describes the issue.
                  </p>
                ) : null}
              </div>

              <div className="mt-6 space-y-2">
                <Label htmlFor="cancellation-reason-details">
                  Tell us a little more
                </Label>
                <Textarea
                  id="cancellation-reason-details"
                  value={reasonDetails}
                  onChange={(event) => {
                    setReasonDetails(event.target.value);
                    setShowValidation(false);
                  }}
                  maxLength={2000}
                  disabled={isProcessing || isLoadingOffers}
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
                disabled={isProcessing || isLoadingOffers}
                className={cn(
                  "h-11 w-full sm:w-36",
                  !hasRequiredDetails && "opacity-60",
                )}
              >
                {isLoadingOffers ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Next"
                )}
              </Button>
              <Button
                variant="outline"
                onClick={handleBack}
                disabled={isProcessing || isLoadingOffers}
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
            </div>

            <div className="flex flex-col-reverse gap-3 border-t border-border px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <Button
                onClick={handleContinueToDetails}
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
