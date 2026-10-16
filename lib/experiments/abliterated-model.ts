import { phLogger } from "@/lib/posthog/server";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import type { PostHog } from "posthog-node";
import {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
  ABLITERATED_SHORT_FOLLOWUP_KEY,
} from "./abliteration-keys";
export {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
  ABLITERATED_SHORT_FOLLOWUP_KEY,
} from "./abliteration-keys";
import type { AbliterationGenerationStepLimit } from "./abliterated-model-steps";
import type { UIMessage } from "ai";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import type { ModelName } from "@/lib/ai/providers";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import {
  ABLITERATION_MODEL_KEY,
  isAbliterationConfigured,
} from "@/lib/ai/abliteration";

export type AbliteratedAssignment = ExperimentAnalyticsContext & {
  key:
    | typeof ABLITERATED_EXPERIMENT_KEY
    | typeof ABLITERATED_MAX_EXPERIMENT_KEY
    | typeof ABLITERATED_PAID_FIRST_STEP_KEY
    | typeof ABLITERATED_PAID_MODERATED_DEFAULT_KEY
    | typeof ABLITERATED_PAID_THREE_STEPS_KEY
    | typeof ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY
    | typeof ABLITERATED_SHORT_FOLLOWUP_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  baselineModel: ModelName;
  selectionSource?: "moderation" | "history" | "paid_first_step";
  moderationEligible?: boolean;
  moderationChecked?: boolean;
  independentHistoryCount?: number;
  generationStepLimit?: AbliterationGenerationStepLimit;
};

const messagesContainUnsupportedFiles = (messages: UIMessage[]): boolean =>
  messages.some((message) =>
    message.parts.some(
      (part) =>
        part.type === "file" &&
        (typeof part.mediaType !== "string" ||
          !part.mediaType.startsWith("image/")),
    ),
  );

const FOLLOWUP_MAX_CHARACTERS = 200;
const FOLLOWUP_SEED_WINDOW_MS = 24 * 60 * 60 * 1000;

const isShortTextFollowup = (messages: UIMessage[]): boolean => {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== "user") return false;
  if (lastMessage.parts.some((part) => part.type !== "text")) return false;
  const text = lastMessage.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
  return text.length > 0 && text.length <= FOLLOWUP_MAX_CHARACTERS;
};

export function isEligibleForAbliteratedModel({
  subscription,
  moderationEligible,
  messages,
  limitRescue = false,
}: {
  subscription: SubscriptionTier;
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
  moderationChecked = true,
  allowsAbliterationContinuation = false,
  independentAbliterationSeedCount = 0,
  lastIndependentAbliterationSeedAt,
  continuationTurn = false,
  now = Date.now(),
  messages,
  limitRescue = false,
  diagnosticContext,
}: {
  posthog?: Pick<PostHog, "getFeatureFlagResult"> | null;
  userId: string;
  selectedModel: ModelName;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  moderationEligible: boolean;
  moderationChecked?: boolean;
  allowsAbliterationContinuation?: boolean;
  independentAbliterationSeedCount?: number;
  lastIndependentAbliterationSeedAt?: number;
  continuationTurn?: boolean;
  now?: number;
  messages: UIMessage[];
  limitRescue?: boolean;
  diagnosticContext?: { chatId: string; requestId: string; logAll?: boolean };
}): Promise<AbliteratedAssignment | undefined> {
  const providerConfigured = isAbliterationConfigured();
  const shortFollowupEligible =
    !moderationEligible &&
    allowsAbliterationContinuation &&
    continuationTurn &&
    independentAbliterationSeedCount >= 2 &&
    typeof lastIndependentAbliterationSeedAt === "number" &&
    Number.isFinite(lastIndependentAbliterationSeedAt) &&
    now >= lastIndependentAbliterationSeedAt &&
    now - lastIndependentAbliterationSeedAt <= FOLLOWUP_SEED_WINDOW_MS &&
    isShortTextFollowup(messages);
  const reportDecision = (reason: string, variant?: string) => {
    if (
      !diagnosticContext ||
      (!diagnosticContext.logAll && independentAbliterationSeedCount < 2)
    )
      return;
    try {
      phLogger.info("Abliteration assignment decision", {
        userId,
        chatId: diagnosticContext.chatId,
        requestId: diagnosticContext.requestId,
        experiment_key: ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
        mode,
        subscription_tier: subscription,
        selected_model_override: selectedModelOverride,
        moderation_eligible: moderationEligible,
        moderation_checked: moderationChecked,
        continuation_moderation_allowed: allowsAbliterationContinuation,
        independent_seed_count: independentAbliterationSeedCount,
        short_followup: isShortTextFollowup(messages),
        provider_configured: providerConfigured,
        reason,
        ...(variant && { variant }),
      });
    } catch {
      // Diagnostics must never change assignment or provider behavior.
    }
  };
  if (
    !providerConfigured ||
    !isEligibleForAbliteratedModel({
      subscription,
      moderationEligible: moderationEligible || shortFollowupEligible,
      messages,
      limitRescue,
    })
  ) {
    let reason = "moderation_not_eligible";
    if (!providerConfigured) reason = "provider_not_configured";
    else if (subscription === "free") reason = "free_user";
    else if (limitRescue) reason = "limit_rescue";
    else if (!messages.length || messagesContainUnsupportedFiles(messages))
      reason = "unsupported_input";
    reportDecision(reason);
    return undefined;
  }

  if (shortFollowupEligible && posthog) {
    try {
      const enabled = await getPostHogFlagWithoutExposure(
        posthog,
        ABLITERATED_SHORT_FOLLOWUP_KEY,
        userId,
        { subscription, subscription_tier: subscription },
      );
      if (enabled === true) {
        reportDecision("short_followup_continuity", "test");
        return {
          key: ABLITERATED_SHORT_FOLLOWUP_KEY,
          variant: "test",
          modelKey: ABLITERATION_MODEL_KEY,
          baselineModel: selectedModel,
          generationStepLimit: 1,
          selectionSource: "history",
          moderationEligible: false,
          moderationChecked,
          independentHistoryCount: independentAbliterationSeedCount,
        };
      }
      reportDecision("short_followup_flag_off");
    } catch {
      reportDecision("short_followup_flag_error");
    }
    return undefined;
  }

  if (!moderationEligible) {
    reportDecision("moderation_not_eligible");
    return undefined;
  }

  reportDecision("moderated_three_step_default", "test");
  return {
    key: ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
    variant: "test",
    modelKey: ABLITERATION_MODEL_KEY,
    baselineModel: selectedModel,
    generationStepLimit: 3,
    selectionSource: "moderation",
    moderationEligible,
    moderationChecked,
  };
}
