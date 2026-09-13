import type {
  CancellationReasonCategory,
  CancellationReasonSubcategory,
} from "@/lib/billing/cancellation-reasons";
import type {
  DowngradeOfferIneligibilityReason,
  PauseDurationMonths,
  PauseOfferIneligibilityReason,
} from "@/lib/billing/retention-offers";
import type { SubscriptionTier } from "@/types";

export type SubscriptionPauseStatusSummary = {
  months: PauseDurationMonths;
  /** When the paid period ends and the pause takes effect (ms). */
  pauseEffectiveAt?: number;
  /** When the plan resumes automatically (ms). */
  resumeAt: number;
};

export type SubscriptionCancellationStatus = {
  hasActiveSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  subscriptionStatus?: "active" | "trialing" | "past_due" | "unpaid";
  latestInvoiceId?: string;
  stripePriceId?: string;
  stripePriceLookupKey?: string;
  renewalAmountDollars?: number;
  renewalCurrency?: string;
  renewalInterval?: string;
  renewalIntervalCount?: number;
  /** Present when the scheduled cancellation is a retention pause. */
  pause?: SubscriptionPauseStatusSummary;
  /** Present when a cheaper plan is scheduled for the next renewal. */
  pendingPlanChange?: SubscriptionPendingPlanChange;
};

export type BillingPortalFlow = "payment_method";

export type KeepSubscriptionResult = {
  kept: true;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  alreadyKept: boolean;
  /** True when keeping the plan also cancelled a scheduled pause. */
  pauseCanceled?: boolean;
  /** True when keeping the plan cancelled a scheduled downgrade. */
  planChangeCanceled?: boolean;
};

export type CancellationReasonInput = {
  reasonCategory: CancellationReasonCategory;
  reasonSubcategory: CancellationReasonSubcategory;
  reasonDetails: string;
};

export type CancelSubscriptionInput = {
  cancellationReason: CancellationReasonInput;
};

export type CancelSubscriptionResult = {
  canceled: true;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  alreadyScheduled: boolean;
};

export type GetRetentionOffersInput = {
  reasonCategory: CancellationReasonCategory;
};

export type RetentionPauseOption = {
  months: PauseDurationMonths;
  resumeAt: number;
};

export type RetentionPauseOffer = {
  eligible: boolean;
  reason?: PauseOfferIneligibilityReason;
  pauseEffectiveAt?: number;
  options: RetentionPauseOption[];
};

export type RetentionDowngradeOffer =
  | {
      eligible: true;
      targetTier: SubscriptionTier;
      targetPlan: string;
      targetAmountDollars?: number;
      currentAmountDollars?: number;
      currency?: string;
      /** When the cheaper plan takes effect: the current paid-through date (ms). */
      effectiveAt?: number;
    }
  | { eligible: false; reason: DowngradeOfferIneligibilityReason };

export type RetentionOffers = {
  offersEnabled: boolean;
  subscriptionTier?: SubscriptionTier;
  plan?: string;
  pause: RetentionPauseOffer;
  downgrade: RetentionDowngradeOffer;
};

export type DowngradeSubscriptionInput = {
  cancellationReason: CancellationReasonInput;
};

export type DowngradeSubscriptionResult = {
  scheduled: true;
  /** When the cheaper plan takes effect (ms). */
  effectiveAt: number;
  fromTier?: SubscriptionTier;
  toTier: SubscriptionTier;
  toPlan: string;
  targetAmountDollars?: number;
  currency?: string;
};

/** A plan change already scheduled on the subscription. */
export type SubscriptionPendingPlanChange = {
  targetTier?: SubscriptionTier;
  targetPlan?: string;
  targetAmountDollars?: number;
  currency?: string;
  effectiveAt: number;
};

export type PauseSubscriptionInput = {
  months: PauseDurationMonths;
  cancellationReason: CancellationReasonInput;
};

export type PauseSubscriptionResult = {
  paused: true;
  months: PauseDurationMonths;
  pauseEffectiveAt: number;
  resumeAt: number;
  alreadyScheduled: boolean;
};

export type ResumeSubscriptionResult = {
  resumed: true;
  stripeSubscriptionId?: string;
  /** The customer already had a live subscription, so nothing was created. */
  alreadyActive: boolean;
};
