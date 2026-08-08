import { KIMI_K3_SLUG } from "@/lib/ai/providers";
import type { ChatMode, SubscriptionTier } from "@/types";
import { PAID_INDIVIDUAL_SUBSCRIPTION_TIERS } from "@/types";

export const KIMI_MAX_REASONING_EFFORT = "max" as const;

const KIMI_MAX_MODEL_KEYS = new Set(["model-opus-4.6", "model-kimi-k3"]);

export function shouldUseMaxKimiReasoning({
  subscription,
  mode,
  selectedModel,
  configuredModelId,
}: {
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel: string;
  configuredModelId: string;
}): boolean {
  return (
    (
      PAID_INDIVIDUAL_SUBSCRIPTION_TIERS as readonly SubscriptionTier[]
    ).includes(subscription) &&
    mode === "agent" &&
    KIMI_MAX_MODEL_KEYS.has(selectedModel) &&
    configuredModelId === KIMI_K3_SLUG
  );
}
