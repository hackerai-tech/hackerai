import type { ModelName } from "@/lib/ai/providers";
import { DEEPSEEK_1017_MODEL_KEY } from "@/lib/experiments/paid-deepseek-1017";
import type { SelectedModel, SubscriptionTier } from "@/types";

/** Resolve the shipped paid Pro/Auto route after moderation and rescue gates. */
export function resolvePaidProAutoModel({
  userId,
  subscription,
  selectedModel,
  selectedModelOverride,
  limitRescue = false,
  modelPolicyActive = false,
}: {
  userId: string;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  selectedModelOverride?: SelectedModel;
  limitRescue?: boolean;
  modelPolicyActive?: boolean;
}): ModelName {
  const selector = selectedModelOverride ?? "auto";
  if (
    userId &&
    !limitRescue &&
    !modelPolicyActive &&
    ["pro", "pro-plus", "ultra", "team"].includes(subscription) &&
    (selector === "auto" || selector === "hackerai-pro") &&
    [
      "model-deepseek-v4-flash-vision-pro",
      "model-deepseek-v4-flash-vision",
      "model-glm-5.3-flash",
      "model-grok-4.5",
    ].includes(selectedModel)
  ) {
    return DEEPSEEK_1017_MODEL_KEY;
  }
  return selectedModel;
}
