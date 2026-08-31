import type { PostHog } from "posthog-node";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import type { ModelName } from "@/lib/ai/providers";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY =
  "paid_agent_glm_5_3_flash_v1";
export const PAID_AGENT_GLM_5_3_FLASH_EXPOSURE_EVENT =
  "paid_agent_glm_5_3_flash_experiment_exposed";
export const PAID_AGENT_GLM_5_3_FLASH_FEATURE_PROPERTY = `$feature/${PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY}`;

export type PaidAgentGlm53FlashExperimentVariant = "control" | "test";
export type PaidAgentGlm53FlashModelKey =
  "model-deepseek-v4-flash-0731" | "model-glm-5.3-flash-agent";

export type PaidAgentGlm53FlashExperimentAssignment = {
  key: typeof PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY;
  variant: PaidAgentGlm53FlashExperimentVariant;
  modelKey: PaidAgentGlm53FlashModelKey;
};

export function isEligibleForPaidAgentGlm53FlashExperiment({
  mode,
  subscription,
  selectedModel,
}: {
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
}): boolean {
  return (
    mode === "agent" &&
    subscription !== "free" &&
    selectedModel === "model-deepseek-v4-flash-0731"
  );
}

export async function evaluatePaidAgentGlm53FlashExperiment({
  posthog,
  userId,
  mode,
  subscription,
  selectedModel,
  requestId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  requestId?: string;
}): Promise<PaidAgentGlm53FlashExperimentAssignment | undefined> {
  if (
    !posthog ||
    !isEligibleForPaidAgentGlm53FlashExperiment({
      mode,
      subscription,
      selectedModel,
    })
  ) {
    return undefined;
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY);

    if (variant !== "control" && variant !== "test") {
      return undefined;
    }

    return {
      key: PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY,
      variant,
      modelKey:
        variant === "test"
          ? "model-glm-5.3-flash-agent"
          : "model-deepseek-v4-flash-0731",
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "paid_agent_glm_5_3_flash_experiment_evaluation_failed",
        service: "model-routing-experiment",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        request_id: requestId ?? "unavailable",
        user_id: userId,
        flag_key: PAID_AGENT_GLM_5_3_FLASH_EXPERIMENT_KEY,
        error_name: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return undefined;
  }
}

export function capturePaidAgentGlm53FlashExperimentExposure({
  posthog,
  userId,
  subscription,
  mode,
  selectedModelOverride,
  selectedModel,
  configuredModel,
  assignment,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  selectedModel: ModelName;
  configuredModel: string;
  assignment?: PaidAgentGlm53FlashExperimentAssignment;
}): void {
  if (!posthog || !assignment) return;

  posthog.capture({
    distinctId: userId,
    event: PAID_AGENT_GLM_5_3_FLASH_EXPOSURE_EVENT,
    properties: {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [PAID_AGENT_GLM_5_3_FLASH_FEATURE_PROPERTY]: assignment.variant,
      subscription,
      subscription_tier: subscription,
      mode,
      selected_model: selectedModel,
      selected_model_override: selectedModelOverride ?? "auto",
      configured_model: configuredModel,
      exposure_surface: "agent_provider_request",
      $process_person_profile: false,
    },
  });
}

export function getPaidAgentGlm53FlashExperimentContext(
  assignment: PaidAgentGlm53FlashExperimentAssignment | undefined,
): ExperimentAnalyticsContext | undefined {
  if (!assignment) return undefined;
  return { key: assignment.key, variant: assignment.variant };
}

export function getActivePaidAgentGlm53FlashExperimentAssignment(
  assignment: PaidAgentGlm53FlashExperimentAssignment | undefined,
  selectedModel: ModelName,
): PaidAgentGlm53FlashExperimentAssignment | undefined {
  return assignment?.modelKey === selectedModel ? assignment : undefined;
}
