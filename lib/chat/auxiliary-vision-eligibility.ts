import type { SelectedModel, SubscriptionTier } from "@/types";
import { isOrcaRouterModelKey } from "@/lib/ai/orcarouter/models";

export function usesGlmFlashForStandardVision(
  subscription: SubscriptionTier | undefined,
  selectedModel?: SelectedModel | null,
): boolean {
  return (
    (subscription === "pro" || subscription === "pro-plus") &&
    (!selectedModel ||
      selectedModel === "auto" ||
      selectedModel === "hackerai-standard")
  );
}

export function isEligibleForDirectGlmVision({
  subscription,
  selectedModelOverride,
}: {
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
}): boolean {
  return (
    subscription !== "free" &&
    selectedModelOverride !== "hackerai-max" &&
    !isOrcaRouterModelKey(selectedModelOverride)
  );
}
