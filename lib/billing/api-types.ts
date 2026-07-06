import type { CancellationReasonCategory } from "@/lib/billing/cancellation-reasons";

export type SubscriptionCancellationStatus = {
  hasActiveSubscription: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
};

export type KeepSubscriptionResult = {
  kept: true;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd?: number;
  alreadyKept: boolean;
};

export type CancellationReasonInput = {
  reasonCategory: CancellationReasonCategory;
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
