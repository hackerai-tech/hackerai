import type { PostHog } from "posthog-node";

import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const AUXILIARY_DEEPSEEK_VISION_FLAG_KEY = "auxiliary-deepseek-vision";
export const AUXILIARY_DEEPSEEK_VISION_EXPOSURE_EVENT =
  "auxiliary_vision_experiment_exposed";
export const AUXILIARY_DEEPSEEK_VISION_FEATURE_PROPERTY = `$feature/${AUXILIARY_DEEPSEEK_VISION_FLAG_KEY}`;

export type AuxiliaryDeepSeekVisionAssignment = {
  key: typeof AUXILIARY_DEEPSEEK_VISION_FLAG_KEY;
  variant: "test";
};

type AuxiliaryVisionEnvironment = { VERCEL_ENV?: string };

export function isEligibleForAuxiliaryDeepSeekVision({
  subscription,
  selectedModelOverride,
}: {
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
}): boolean {
  return subscription !== "free" && selectedModelOverride !== "hackerai-max";
}

export function resolveAuxiliaryDeepSeekVisionPreviewAssignment(
  environment: AuxiliaryVisionEnvironment = {
    VERCEL_ENV: process.env.VERCEL_ENV,
  },
): AuxiliaryDeepSeekVisionAssignment | undefined {
  if (environment.VERCEL_ENV !== "preview") return undefined;
  return { key: AUXILIARY_DEEPSEEK_VISION_FLAG_KEY, variant: "test" };
}

export async function evaluateAuxiliaryDeepSeekVisionFlag({
  posthog,
  userId,
  subscription,
  selectedModelOverride,
  requestId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  requestId?: string;
}): Promise<AuxiliaryDeepSeekVisionAssignment | undefined> {
  if (
    !isEligibleForAuxiliaryDeepSeekVision({
      subscription,
      selectedModelOverride,
    })
  ) {
    return undefined;
  }

  const previewAssignment = resolveAuxiliaryDeepSeekVisionPreviewAssignment();
  if (previewAssignment) return previewAssignment;
  if (!posthog) return undefined;

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [AUXILIARY_DEEPSEEK_VISION_FLAG_KEY],
    });
    const value = flags.getFlag(AUXILIARY_DEEPSEEK_VISION_FLAG_KEY);
    if (value !== true && value !== "test") return undefined;
    return { key: AUXILIARY_DEEPSEEK_VISION_FLAG_KEY, variant: "test" };
  } catch (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "auxiliary_vision_flag_evaluation_failed",
        service: "model-routing-experiment",
        environment:
          process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        request_id: requestId ?? "unavailable",
        user_id: userId,
        flag_key: AUXILIARY_DEEPSEEK_VISION_FLAG_KEY,
        error_name: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return undefined;
  }
}

export function createAuxiliaryVisionExposureRecorder({
  posthog,
  userId,
  subscription,
  mode,
  selectedModelOverride,
  getSelectedModel,
  assignment,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  getSelectedModel: () => string;
  assignment?: AuxiliaryDeepSeekVisionAssignment;
}): (source: "attachment" | "file_view") => void {
  let captured = false;

  return (source) => {
    if (captured || !posthog || !assignment) return;
    captured = true;
    posthog.capture({
      distinctId: userId,
      event: AUXILIARY_DEEPSEEK_VISION_EXPOSURE_EVENT,
      properties: {
        experiment_key: assignment.key,
        experiment_variant: assignment.variant,
        [AUXILIARY_DEEPSEEK_VISION_FEATURE_PROPERTY]: assignment.variant,
        subscription,
        subscription_tier: subscription,
        mode,
        selected_model_override: selectedModelOverride ?? "auto",
        selected_model: getSelectedModel(),
        exposure_surface: source,
        $process_person_profile: false,
      },
    });
  };
}
