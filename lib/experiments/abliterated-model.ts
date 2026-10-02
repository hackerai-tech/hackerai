import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import { phLogger } from "@/lib/posthog/server";
import { ABLITERATION_HISTORY_THRESHOLD } from "./abliteration-history";
import {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
} from "./abliteration-keys";
export {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
} from "./abliteration-keys";
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

export const ABLITERATION_CONTINUITY_FLAG = "abliteration_chat_continuity_v1";
export type AbliteratedAssignment = ExperimentAnalyticsContext & {
  key:
    typeof ABLITERATED_EXPERIMENT_KEY | typeof ABLITERATED_MAX_EXPERIMENT_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  baselineModel: ModelName;
  selectionSource?: "moderation" | "history";
  independentHistoryCount?: number;
};

const LARGE_V2_BASELINE_MODELS = new Set<ModelName>([
  "model-deepseek-v4-flash-vision-pro",
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
    subscription !== "free" &&
    !limitRescue &&
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
  previewDiagnosticContext,
}: {
  posthog: Pick<PostHog, "getFeatureFlagResult"> | null;
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
  previewDiagnosticContext?: { chatId: string; requestId: string };
}): Promise<AbliteratedAssignment | undefined> {
  const providerConfigured = isAbliterationConfigured();
  const reportMaxDecision = (reason: string, variant?: string) => {
    if (!previewDiagnosticContext || selectedModelOverride !== "hackerai-max")
      return;
    try {
      phLogger.info("Preview Max Abliteration assignment decision", {
        userId,
        chatId: previewDiagnosticContext.chatId,
        requestId: previewDiagnosticContext.requestId,
        experiment_key: ABLITERATED_MAX_EXPERIMENT_KEY,
        mode,
        subscription_tier: subscription,
        moderation_eligible: moderationEligible,
        provider_configured: providerConfigured,
        posthog_configured: Boolean(posthog),
        reason,
        ...(variant && { variant }),
      });
    } catch {
      // Diagnostics must never change assignment or provider behavior.
    }
  };
  const historyEligible =
    subscription !== "free" &&
    allowsAbliterationContinuation &&
    Number.isInteger(independentAbliterationResponses) &&
    independentAbliterationResponses >= ABLITERATION_HISTORY_THRESHOLD;
  if (
    !posthog ||
    !providerConfigured ||
    !isEligibleForAbliteratedModel({
      subscription,
      mode,
      selectedModelOverride,
      moderationEligible: moderationEligible || historyEligible,
      messages,
      limitRescue,
    })
  ) {
    let reason = "moderation_not_eligible";
    if (!posthog) reason = "posthog_not_configured";
    else if (!providerConfigured) reason = "provider_not_configured";
    else if (subscription === "free") reason = "free_user";
    else if (limitRescue) reason = "limit_rescue";
    else if (!messages.length || messagesContainUnsupportedFiles(messages))
      reason = "unsupported_input";
    reportMaxDecision(reason);
    return undefined;
  }

  const experimentKey = ABLITERATED_EXPERIMENT_KEY;
  try {
    // Callers normalize the selector against current Max entitlements first.
    // This independent trial never inherits the historical continuity route.
    if (selectedModelOverride === "hackerai-max" && moderationEligible) {
      const maxVariant = await getPostHogFlagWithoutExposure(
        posthog,
        ABLITERATED_MAX_EXPERIMENT_KEY,
        userId,
        { subscription, subscription_tier: subscription },
      );
      if (maxVariant === "test" || maxVariant === "control") {
        reportMaxDecision("assigned", maxVariant);
        return {
          key: ABLITERATED_MAX_EXPERIMENT_KEY,
          variant: maxVariant,
          modelKey:
            maxVariant === "test" ? ABLITERATION_MODEL_KEY : selectedModel,
          baselineModel: selectedModel,
          selectionSource: "moderation",
        };
      }
      reportMaxDecision(
        maxVariant === false
          ? "flag_inactive_or_unmatched"
          : "flag_unavailable",
      );
    } else if (!moderationEligible) {
      reportMaxDecision("moderation_not_eligible");
    }
    const variant = await getPostHogFlagWithoutExposure(
      posthog,
      experimentKey,
      userId,
      { subscription, subscription_tier: subscription },
    );
    if (variant !== "test" && variant !== "control") return undefined;
    if (!moderationEligible) {
      // History is a preference within parent treatment, never an authorization.
      if (variant !== "test") return undefined;
      const continuityEnabled = await getPostHogFlagWithoutExposure(
        posthog,
        ABLITERATION_CONTINUITY_FLAG,
        userId,
        { subscription, subscription_tier: subscription },
      );
      if (continuityEnabled !== true) return undefined;
    }
    return {
      selectionSource: moderationEligible ? "moderation" : "history",
      independentHistoryCount: independentAbliterationResponses,
      key: experimentKey,
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
    reportMaxDecision("flag_lookup_failed");
    return undefined;
  }
}
