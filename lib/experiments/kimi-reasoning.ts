import type { PostHog } from "posthog-node";
import { KIMI_K3_SLUG } from "@/lib/ai/providers";
import type { ChatMode, SubscriptionTier } from "@/types";
import { PAID_INDIVIDUAL_SUBSCRIPTION_TIERS } from "@/types";

export const KIMI_REASONING_EXPERIMENT_KEY =
  "agent_max_kimi_k3_reasoning_effort_v1";

export type KimiReasoningExperimentVariant = "control" | "max";
export type KimiReasoningEffort = "high" | "max";

export type KimiReasoningExperimentAssignment = {
  key: typeof KIMI_REASONING_EXPERIMENT_KEY;
  variant: KimiReasoningExperimentVariant;
  reasoningEffort: KimiReasoningEffort;
};

const KIMI_MAX_MODEL_KEYS = new Set(["model-opus-4.6", "model-kimi-k3"]);

export function isEligibleForKimiReasoningExperiment({
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

export async function evaluateKimiReasoningExperiment({
  posthog,
  userId,
  subscription,
  mode,
  selectedModel,
  configuredModelId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel: string;
  configuredModelId: string;
}): Promise<KimiReasoningExperimentAssignment | undefined> {
  if (
    !posthog ||
    !isEligibleForKimiReasoningExperiment({
      subscription,
      mode,
      selectedModel,
      configuredModelId,
    })
  ) {
    return undefined;
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [KIMI_REASONING_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(KIMI_REASONING_EXPERIMENT_KEY);

    if (variant !== "control" && variant !== "max") {
      return undefined;
    }

    return {
      key: KIMI_REASONING_EXPERIMENT_KEY,
      variant,
      reasoningEffort: variant === "max" ? "max" : "high",
    };
  } catch (error) {
    console.warn("Kimi reasoning experiment evaluation failed", {
      event: "kimi_reasoning_experiment_evaluation_failed",
      flag_key: KIMI_REASONING_EXPERIMENT_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}
