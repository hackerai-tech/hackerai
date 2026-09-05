import type {
  CancellationReasonCategory,
  CancellationReasonSubcategory,
} from "@/lib/billing/cancellation-reasons";
import type {
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
};

export type BillingPortalFlow = "payment_method";

export type KeepSubscriptionResult = {
  kept: true;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  alreadyKept: boolean;
  /** True when keeping the plan also cancelled a scheduled pause. */
  pauseCanceled?: boolean;
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

export type RetentionOffers = {
  offersEnabled: boolean;
  subscriptionTier?: SubscriptionTier;
  plan?: string;
  pause: RetentionPauseOffer;
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
