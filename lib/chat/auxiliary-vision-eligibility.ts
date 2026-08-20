import type { SelectedModel, SubscriptionTier } from "@/types";

export function isEligibleForAuxiliaryDeepSeekVision({
  subscription,
  selectedModelOverride,
}: {
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
}): boolean {
  return subscription !== "free" && selectedModelOverride !== "hackerai-max";
}
