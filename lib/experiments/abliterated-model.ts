import type { PostHog } from "posthog-node";
import type { UIMessage } from "ai";
import type { SelectedModel, SubscriptionTier } from "@/types";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import {
  ABLITERATION_MODEL_KEY,
  isAbliterationConfigured,
} from "@/lib/ai/abliteration";

export const ABLITERATED_EXPERIMENT_KEY = "abliterated_paid_moderated_v1";
export type AbliteratedAssignment = ExperimentAnalyticsContext & {
  key: typeof ABLITERATED_EXPERIMENT_KEY;
  variant: "control" | "test";
  modelKey: string;
  baselineModel: string;
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
    (!selectedModelOverride ||
      selectedModelOverride === "auto" ||
      selectedModelOverride === "hackerai-standard") &&
    messages.length > 0 &&
    !messages.some((message) =>
      message.parts.some((part) => part.type === "file"),
    )
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
  selectedModel: string;
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
      modelKey: variant === "test" ? ABLITERATION_MODEL_KEY : selectedModel,
      baselineModel: selectedModel,
    };
  } catch {
    return undefined;
  }
}
