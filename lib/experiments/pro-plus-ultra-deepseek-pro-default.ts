import type { PostHog } from "posthog-node";

import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import type { ModelName } from "@/lib/ai/providers";
import type { ChatApiEndpoint } from "@/lib/api/agent-endpoints";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY =
  "pro_plus_ultra_deepseek_pro_default_v1";
export const PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPOSURE_EVENT =
  "pro_plus_ultra_deepseek_pro_default_exposed";
export const PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_FEATURE_PROPERTY = `$feature/${PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY}`;

export type ProPlusUltraDeepSeekProDefaultVariant = "control" | "deepseek_pro";

export type ProPlusUltraDeepSeekProDefaultAssignment = {
  key: typeof PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY;
  variant: ProPlusUltraDeepSeekProDefaultVariant;
  modelKey: "model-deepseek-v4-flash-0731" | "model-deepseek-v4-pro-0813";
};

export function isEligibleForProPlusUltraDeepSeekProDefault({
  subscription,
  selectedModelOverride,
  hasImageAttachment,
}: {
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  hasImageAttachment: boolean;
}): boolean {
  return (
    (subscription === "pro-plus" || subscription === "ultra") &&
    (!selectedModelOverride || selectedModelOverride === "auto") &&
    !hasImageAttachment
  );
}

export async function evaluateProPlusUltraDeepSeekProDefault({
  posthog,
  userId,
  subscription,
  selectedModelOverride,
  hasImageAttachment,
  requestId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  hasImageAttachment: boolean;
  requestId?: string;
}): Promise<ProPlusUltraDeepSeekProDefaultAssignment | undefined> {
  if (
    !posthog ||
    !isEligibleForProPlusUltraDeepSeekProDefault({
      subscription,
      selectedModelOverride,
      hasImageAttachment,
    })
  ) {
    return undefined;
  }

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY],
    });
    const variant = flags.getFlag(
      PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
    );

    if (variant !== "control" && variant !== "deepseek_pro") {
      return undefined;
    }

    return {
      key: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
      variant,
      modelKey:
        variant === "deepseek_pro"
          ? "model-deepseek-v4-pro-0813"
          : "model-deepseek-v4-flash-0731",
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "pro_plus_ultra_deepseek_pro_default_evaluation_failed",
        service: "model-routing-experiment",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        request_id: requestId ?? "unavailable",
        user_id: userId,
        flag_key: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPERIMENT_KEY,
        error_name: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return undefined;
  }
}

export function getActiveProPlusUltraDeepSeekProDefaultAssignment(
  assignment: ProPlusUltraDeepSeekProDefaultAssignment | undefined,
  selectedModel: ModelName,
): ProPlusUltraDeepSeekProDefaultAssignment | undefined {
  return assignment?.modelKey === selectedModel ? assignment : undefined;
}

export function getProPlusUltraDeepSeekProDefaultContext(
  assignment: ProPlusUltraDeepSeekProDefaultAssignment | undefined,
): ExperimentAnalyticsContext | undefined {
  if (!assignment) return undefined;
  return { key: assignment.key, variant: assignment.variant };
}

export function captureProPlusUltraDeepSeekProDefaultExposure({
  posthog,
  userId,
  subscription,
  mode,
  endpoint,
  selectedModelOverride,
  selectedModel,
  configuredModel,
  chatId,
  triggerRunId,
  assignment,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  endpoint: ChatApiEndpoint;
  selectedModelOverride?: SelectedModel;
  selectedModel: ModelName;
  configuredModel: string;
  chatId: string;
  triggerRunId?: string;
  assignment?: ProPlusUltraDeepSeekProDefaultAssignment;
}): void {
  if (!posthog || !assignment) return;

  posthog.capture({
    distinctId: userId,
    event: PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_EXPOSURE_EVENT,
    properties: {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [PRO_PLUS_ULTRA_DEEPSEEK_PRO_DEFAULT_FEATURE_PROPERTY]:
        assignment.variant,
      subscription,
      subscription_tier: subscription,
      mode,
      endpoint,
      selected_model: selectedModel,
      selected_model_override: selectedModelOverride ?? "auto",
      configured_model: configuredModel,
      exposure_surface: "provider_request",
      chat_id: chatId,
      ...(triggerRunId && { trigger_run_id: triggerRunId }),
      $process_person_profile: false,
    },
  });
}
