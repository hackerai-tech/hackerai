import { ABLITERATION_HISTORY_THRESHOLD } from "./abliteration-history";
import type { PostHog } from "posthog-node";
import type { UIMessage } from "ai";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import type { ModelName } from "@/lib/ai/providers";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import {
  ABLITERATION_MODEL_KEY,
  ABLITERATION_LARGE_V2_MODEL_KEY,
  isAbliterationConfigured,
} from "@/lib/ai/abliteration";
import { uiMessagesContainImageViewResult } from "@/lib/chat/multimodal-tool-result-recovery";

export const ABLITERATED_EXPERIMENT_KEY = "abliterated_paid_moderated_v1";
export const ABLITERATION_CONTINUITY_FLAG = "abliteration_chat_continuity_v1";
export type AbliteratedAssignment = ExperimentAnalyticsContext & {
  key: typeof ABLITERATED_EXPERIMENT_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  baselineModel: ModelName;
  selectionSource?: "moderation" | "history";
  independentHistoryCount?: number;
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

export function isEligibleForAbliteratedModel({
  subscription,
  mode,
  selectedModelOverride,
  moderationEligible,
  messages,
  limitRescue = false,
}: {
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  moderationEligible: boolean;
  messages: UIMessage[];
  limitRescue?: boolean;
}): boolean {
  return (
    !limitRescue &&
    (subscription !== "free" || mode === "agent") &&
    moderationEligible &&
    messages.length > 0 &&
    !messagesContainUnsupportedFiles(messages)
  );
}

export async function evaluateAbliteratedModel({
  posthog,
  userId,
  selectedModel,
  subscription,
  mode,
  selectedModelOverride,
  moderationEligible,
  allowsAbliterationContinuation = false,
  independentAbliterationResponses = 0,
  messages,
  limitRescue = false,
}: {
  posthog: Pick<PostHog, "getFeatureFlag"> | null;
  userId: string;
  selectedModel: ModelName;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  moderationEligible: boolean;
  allowsAbliterationContinuation?: boolean;
  independentAbliterationResponses?: number;
  messages: UIMessage[];
  limitRescue?: boolean;
}): Promise<AbliteratedAssignment | undefined> {
  const historyEligible =
    allowsAbliterationContinuation &&
    Number.isInteger(independentAbliterationResponses) &&
    independentAbliterationResponses >= ABLITERATION_HISTORY_THRESHOLD;
  if (
    !posthog ||
    !isAbliterationConfigured() ||
    !isEligibleForAbliteratedModel({
      subscription,
      mode,
      selectedModelOverride,
      moderationEligible: moderationEligible || historyEligible,
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
    if (!moderationEligible) {
      // History is a preference within parent treatment, never an authorization.
      if (variant !== "test") return undefined;
      const continuityEnabled = await posthog.getFeatureFlag(
        ABLITERATION_CONTINUITY_FLAG,
        userId,
        {
          sendFeatureFlagEvents: false,
          personProperties: { subscription, subscription_tier: subscription },
        },
      );
      if (continuityEnabled !== true) return undefined;
    }
    return {
      selectionSource: moderationEligible ? "moderation" : "history",
      independentHistoryCount: independentAbliterationResponses,
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
