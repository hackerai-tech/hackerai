import type { PostHog } from "posthog-node";
import {
  DEEPSEEK_V4_FLASH_PREVIOUS_SLUG,
  DEEPSEEK_V4_FLASH_SLUG,
} from "@/lib/ai/providers";
import type { ChatMode, SubscriptionTier } from "@/types";

export const FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY = "hac56-free-deepseek-route";
export const FREE_DEEPSEEK_ROUTE_EXPOSURE_EVENT =
  "hac56_free_deepseek_route_experiment_exposed";
export const FREE_DEEPSEEK_ROUTE_FEATURE_PROPERTY = `$feature/${FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY}`;

export type FreeDeepSeekRouteExperimentVariant = "control" | "current_0731_low";
export type FreeDeepSeekRouteReasoningEffort = "low" | "high";

export type FreeDeepSeekRouteExperimentAssignment = {
  key: typeof FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY;
  variant: FreeDeepSeekRouteExperimentVariant;
  modelSlug:
    typeof DEEPSEEK_V4_FLASH_SLUG | typeof DEEPSEEK_V4_FLASH_PREVIOUS_SLUG;
  reasoningEffort: FreeDeepSeekRouteReasoningEffort;
};

export const getFreeDeepSeekRoutePackage = (
  assignment: FreeDeepSeekRouteExperimentAssignment,
): "previous_flash_high" | "current_0731_low" =>
  assignment.variant === "control" ? "previous_flash_high" : "current_0731_low";

const FREE_DEEPSEEK_MODEL_KEYS = new Set([
  "ask-model-free",
  "agent-model-free",
]);

export function isEligibleForFreeDeepSeekRouteExperiment({
  subscription,
  mode,
  selectedModel,
}: {
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel: string;
}): boolean {
  return (
    subscription === "free" &&
    (mode === "ask" || mode === "agent") &&
    FREE_DEEPSEEK_MODEL_KEYS.has(selectedModel)
  );
}

export async function evaluateFreeDeepSeekRouteExperiment({
  posthog,
  userId,
  subscription,
  mode,
  selectedModel,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModel: string;
}): Promise<FreeDeepSeekRouteExperimentAssignment | undefined> {
  if (
    !posthog ||
    !isEligibleForFreeDeepSeekRouteExperiment({
      subscription,
      mode,
      selectedModel,
    })
  ) {
    return undefined;
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY);

    if (variant === "current_0731_low") {
      return {
        key: FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY,
        variant,
        modelSlug: DEEPSEEK_V4_FLASH_SLUG,
        reasoningEffort: mode === "ask" ? "low" : "high",
      };
    }

    if (variant === "control") {
      return {
        key: FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY,
        variant,
        modelSlug: DEEPSEEK_V4_FLASH_PREVIOUS_SLUG,
        reasoningEffort: "high",
      };
    }

    return undefined;
  } catch (error) {
    console.warn("Free DeepSeek route experiment evaluation failed", {
      event: "free_deepseek_route_experiment_evaluation_failed",
      flag_key: FREE_DEEPSEEK_ROUTE_EXPERIMENT_KEY,
      error_name: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}

export function captureFreeDeepSeekRouteExperimentExposure({
  posthog,
  userId,
  mode,
  assignment,
  responseModel,
  fallbackServed,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  mode: ChatMode;
  assignment: FreeDeepSeekRouteExperimentAssignment | undefined;
  responseModel?: string;
  fallbackServed?: boolean;
}): void {
  if (!posthog || !assignment || !responseModel) return;

  posthog.capture({
    distinctId: userId,
    event: FREE_DEEPSEEK_ROUTE_EXPOSURE_EVENT,
    properties: {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [FREE_DEEPSEEK_ROUTE_FEATURE_PROPERTY]: assignment.variant,
      assigned_variant: getFreeDeepSeekRoutePackage(assignment),
      route_package: getFreeDeepSeekRoutePackage(assignment),
      mode,
      configured_model: assignment.modelSlug,
      response_model: responseModel,
      reasoning_effort: assignment.reasoningEffort,
      ...(fallbackServed !== undefined && {
        fallback_served: fallbackServed,
      }),
      $process_person_profile: false,
    },
  });
}
