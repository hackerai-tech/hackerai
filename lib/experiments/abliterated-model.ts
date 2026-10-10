import { phLogger } from "@/lib/posthog/server";
import {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
} from "./abliteration-keys";
export {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
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
    | typeof ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY;
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
  userId,
  selectedModel,
  subscription,
  mode,
  selectedModelOverride,
  moderationEligible,
  moderationChecked = true,
  messages,
  limitRescue = false,
  previewDiagnosticContext,
}: {
  userId: string;
  selectedModel: ModelName;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  moderationEligible: boolean;
  moderationChecked?: boolean;
  messages: UIMessage[];
  limitRescue?: boolean;
  previewDiagnosticContext?: { chatId: string; requestId: string };
}): Promise<AbliteratedAssignment | undefined> {
  const providerConfigured = isAbliterationConfigured();
  const reportDecision = (reason: string, variant?: string) => {
    if (!previewDiagnosticContext) return;
    try {
      phLogger.info("Preview Abliteration assignment decision", {
        userId,
        chatId: previewDiagnosticContext.chatId,
        requestId: previewDiagnosticContext.requestId,
        experiment_key: ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
        mode,
        subscription_tier: subscription,
        selected_model_override: selectedModelOverride,
        moderation_eligible: moderationEligible,
        moderation_checked: moderationChecked,
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
      moderationEligible,
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
