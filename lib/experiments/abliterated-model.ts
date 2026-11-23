import {
  INFERENCE_CYBER_FLAG,
  INFERENCE_CYBER_MODEL_KEY,
  isInferenceConfigured,
} from "@/lib/ai/inference";
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
  ABLITERATED_PRO_THREE_STEPS_KEY,
  ABLITERATED_FREE_THREE_STEPS_KEY,
  ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
} from "./abliteration-keys";
export {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
  ABLITERATED_PRO_THREE_STEPS_KEY,
  ABLITERATED_FREE_THREE_STEPS_KEY,
  ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
} from "./abliteration-keys";
import type { AbliterationGenerationStepLimit } from "./abliterated-model-steps";
import type { UIMessage } from "ai";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import type { ModelName } from "@/lib/ai/providers";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";

export type AbliteratedAssignment = ExperimentAnalyticsContext & {
  key:
    | typeof ABLITERATED_EXPERIMENT_KEY
    | typeof ABLITERATED_MAX_EXPERIMENT_KEY
    | typeof ABLITERATED_PAID_FIRST_STEP_KEY
    | typeof ABLITERATED_PAID_MODERATED_DEFAULT_KEY
    | typeof ABLITERATED_PAID_THREE_STEPS_KEY
    | typeof ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY
    | typeof ABLITERATED_PRO_THREE_STEPS_KEY
    | typeof ABLITERATED_FREE_THREE_STEPS_KEY
    | typeof ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY
    | typeof INFERENCE_CYBER_FLAG;
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
  posthog,
  userId,
  selectedModel,
  subscription,
  mode,
  selectedModelOverride,
  moderationEligible,
  moderationChecked = true,
  allowsFreeAbliteration = false,
  newUserTurn = false,
  messages,
  limitRescue = false,
  diagnosticContext,
  inferenceEnvironment,
}: {
  posthog?: Pick<PostHog, "getFeatureFlagResult"> | null;
  userId: string;
  selectedModel: ModelName;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  moderationEligible: boolean;
  moderationChecked?: boolean;
  allowsFreeAbliteration?: boolean;
  newUserTurn?: boolean;
  messages: UIMessage[];
  limitRescue?: boolean;
  diagnosticContext?: { chatId: string; requestId: string; logAll?: boolean };
  inferenceEnvironment?: "preview" | "production";
}): Promise<AbliteratedAssignment | undefined> {
  const reportDecision = (
    reason: string,
    variant?: string,
    experimentKey = ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
  ) => {
    if (!diagnosticContext?.logAll) return;
    try {
      phLogger.info("Abliteration assignment decision", {
        userId,
        chatId: diagnosticContext.chatId,
        requestId: diagnosticContext.requestId,
        experiment_key: experimentKey,
        mode,
        subscription_tier: subscription,
        selected_model_override: selectedModelOverride,
        moderation_eligible: moderationEligible,
        moderation_checked: moderationChecked,
        reason,
        ...(variant && { variant }),
      });
    } catch {
      // Diagnostics must never change assignment or provider behavior.
    }
  };
  // Only trusted deployed callers can enable the direct-provider rollout.
  // Evaluate lazily after application eligibility. Without Inference, every
  // request keeps its selected model with the usual authorization context.
  const evaluateInference = async (): Promise<boolean> => {
    if (!inferenceEnvironment || !isInferenceConfigured() || !posthog)
      return false;
    try {
      return (
        (await getPostHogFlagWithoutExposure(
          posthog,
          INFERENCE_CYBER_FLAG,
          userId,
          { subscription, subscription_tier: subscription },
        )) === true
      );
    } catch {
      return false;
    }
  };
  // The shipped Free policy is independent of experiment/analytics availability.
  // Keep the selected Free baseline for generations after the first three.
  if (subscription === "free") {
    if (
      !userId ||
      limitRescue ||
      !newUserTurn ||
      !moderationChecked ||
      !moderationEligible ||
      !allowsFreeAbliteration ||
      !messages.length ||
      messagesContainUnsupportedFiles(messages)
    ) {
      reportDecision(
        "free_user",
        undefined,
        ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
      );
      return undefined;
    }
    if (!(await evaluateInference())) {
      reportDecision(
        "provider_not_configured",
        undefined,
        ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
      );
      return undefined;
    }
    return {
      key: ABLITERATED_FREE_THREE_STEPS_DEFAULT_KEY,
      variant: "test",
      modelKey: INFERENCE_CYBER_MODEL_KEY,
      baselineModel: selectedModel,
      generationStepLimit: 3,
      selectionSource: "moderation",
      moderationEligible,
      moderationChecked,
    };
  }
  if (
    !isEligibleForAbliteratedModel({
      subscription,
      moderationEligible,
      messages,
      limitRescue,
    })
  ) {
    let reason = "moderation_not_eligible";
    if (limitRescue) reason = "limit_rescue";
    else if (!messages.length || messagesContainUnsupportedFiles(messages))
      reason = "unsupported_input";
    reportDecision(reason);
    return undefined;
  }

  if (!(await evaluateInference())) {
    reportDecision("provider_not_configured");
    return undefined;
  }

  reportDecision("inference_cyber_rollout", "test", INFERENCE_CYBER_FLAG);
  return {
    key: INFERENCE_CYBER_FLAG,
    variant: "test",
    modelKey: INFERENCE_CYBER_MODEL_KEY,
    baselineModel: selectedModel,
    generationStepLimit: 3,
    selectionSource: "moderation",
    moderationEligible,
    moderationChecked,
  };
}
