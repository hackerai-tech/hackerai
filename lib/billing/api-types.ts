import type {
  CancellationReasonCategory,
  CancellationReasonSubcategory,
} from "@/lib/billing/cancellation-reasons";

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
};

export type BillingPortalFlow = "payment_method";

export type KeepSubscriptionResult = {
  kept: true;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  alreadyKept: boolean;
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
