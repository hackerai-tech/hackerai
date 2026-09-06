import type { PostHog } from "posthog-node";
import type { UIMessage } from "ai";
import type { SelectedModel, SubscriptionTier } from "@/types";
import type { ModelName } from "@/lib/ai/providers";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import {
  ABLITERATION_MODEL_KEY,
  ABLITERATION_LARGE_V2_MODEL_KEY,
  isAbliterationConfigured,
} from "@/lib/ai/abliteration";
import { uiMessagesContainImageViewResult } from "@/lib/chat/multimodal-tool-result-recovery";
import { ABLITERATION_MAX_IMAGES_PER_REQUEST } from "@/lib/ai/abliteration-media";

export const ABLITERATED_EXPERIMENT_KEY = "abliterated_paid_moderated_v1";
export type AbliteratedAssignment = ExperimentAnalyticsContext & {
  key: typeof ABLITERATED_EXPERIMENT_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  baselineModel: ModelName;
};

const LARGE_V2_BASELINE_MODELS = new Set<ModelName>([
  "model-deepseek-v4-pro",
  "model-deepseek-v4-pro-0813",
  "model-grok-4.6",
  "model-grok-4.6-pro",
]);

export const getAbliterationTreatmentModel = (
  baselineModel: ModelName,
  requiresVision = false,
): ModelName =>
  !requiresVision && LARGE_V2_BASELINE_MODELS.has(baselineModel)
    ? ABLITERATION_LARGE_V2_MODEL_KEY
    : ABLITERATION_MODEL_KEY;

const messagesRequireVision = (messages: UIMessage[]): boolean =>
  uiMessagesContainImageViewResult(messages) ||
  messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "file" &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/"),
    ),
  );

const messagesContainUnsupportedFiles = (messages: UIMessage[]): boolean =>
  messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "file" &&
        (typeof part.mediaType !== "string" ||
          !part.mediaType.startsWith("image/")),
    ),
  );

// Abliteration applies this cap to the complete provider request, not each
// message or upload action. Count the provider-visible history at that scope.
const messagesExceedImageLimit = (messages: UIMessage[]): boolean => {
  let imageCount = 0;

  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === "file" &&
        typeof part.mediaType === "string" &&
        part.mediaType.startsWith("image/")
      ) {
        imageCount += 1;
        if (imageCount > ABLITERATION_MAX_IMAGES_PER_REQUEST) return true;
      }
    }
  }

  return false;
};

export function isEligibleForAbliteratedModel({
  subscription,
  selectedModelOverride,
  moderationEligible,
  messages,
  limitRescue = false,
}: {
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  moderationEligible: boolean;
  messages: UIMessage[];
  limitRescue?: boolean;
}): boolean {
  return (
    !limitRescue &&
    subscription !== "free" &&
    moderationEligible &&
    messages.length > 0 &&
    !messagesContainUnsupportedFiles(messages) &&
    !messagesExceedImageLimit(messages)
  );
}

export async function evaluateAbliteratedModel({
  posthog,
  userId,
  selectedModel,
  subscription,
  selectedModelOverride,
  moderationEligible,
  messages,
  limitRescue = false,
}: {
  posthog: Pick<PostHog, "getFeatureFlag"> | null;
  userId: string;
  selectedModel: ModelName;
  subscription: SubscriptionTier;
  selectedModelOverride?: SelectedModel;
  moderationEligible: boolean;
  messages: UIMessage[];
  limitRescue?: boolean;
}): Promise<AbliteratedAssignment | undefined> {
  if (
    !posthog ||
    !isAbliterationConfigured() ||
    !isEligibleForAbliteratedModel({
      subscription,
      selectedModelOverride,
      moderationEligible,
      messages,
      limitRescue,
    })
  )
    return undefined;

  try {
    // This pinned SDK's evaluateFlags.getFlag emits exposure on access. Use the
    // supported no-event API until it supports deferring exposure explicitly.
    const variant = await posthog.getFeatureFlag(
      ABLITERATED_EXPERIMENT_KEY,
      userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: { subscription, subscription_tier: subscription },
      },
    );
    if (variant !== "test" && variant !== "control") return undefined;
    return {
      key: ABLITERATED_EXPERIMENT_KEY,
      variant,
      modelKey:
        variant === "test"
          ? getAbliterationTreatmentModel(
              selectedModel,
              messagesRequireVision(messages),
            )
          : selectedModel,
      baselineModel: selectedModel,
    };
  } catch {
    return undefined;
  }
}
