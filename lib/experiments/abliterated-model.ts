import {
  INFERENCE_CYBER_FLAG,
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
    | typeof ABLITERATED_PRO_THREE_STEPS_KEY
    | typeof ABLITERATED_FREE_THREE_STEPS_KEY
    | typeof INFERENCE_CYBER_FLAG;
  variant: "control" | "test";
  modelKey: ModelName;
  baselineModel: ModelName;
  selectionSource?: "moderation" | "history" | "paid_first_step";
  moderationEligible?: boolean;
  moderationChecked?: boolean;
  independentHistoryCount?: number;
  generationStepLimit?: AbliterationGenerationStepLimit;
  inferenceCyberEnabled?: boolean;
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
  const providerConfigured = isAbliterationConfigured();
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
        provider_configured: providerConfigured,
        reason,
        ...(variant && { variant }),
      });
    } catch {
      // Diagnostics must never change assignment or provider behavior.
    }
  };
  // Free enrollment is independent of paid routing and the closed Pro trial.
  // Capture today's selected Free route for both control and later steps.
  if (subscription === "free") {
    if (
      !providerConfigured ||
      !posthog ||
      !userId ||
      limitRescue ||
      !newUserTurn ||
      !moderationChecked ||
      !moderationEligible ||
      !allowsFreeAbliteration ||
      !messages.length ||
      messagesContainUnsupportedFiles(messages)
    ) {
      reportDecision("free_user", undefined, ABLITERATED_FREE_THREE_STEPS_KEY);
      return undefined;
    }
    try {
      const variant = await getPostHogFlagWithoutExposure(
        posthog,
        ABLITERATED_FREE_THREE_STEPS_KEY,
        userId,
        { subscription, subscription_tier: subscription },
      );
      if (variant !== "control" && variant !== "test") return undefined;
      return {
        key: ABLITERATED_FREE_THREE_STEPS_KEY,
        variant,
        modelKey: variant === "test" ? ABLITERATION_MODEL_KEY : selectedModel,
        baselineModel: selectedModel,
        generationStepLimit: 3,
        inferenceCyberEnabled: false,
        selectionSource: "moderation",
        moderationEligible,
        moderationChecked,
      };
    } catch {
      return undefined;
    }
  }
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
    else if (limitRescue) reason = "limit_rescue";
    else if (!messages.length || messagesContainUnsupportedFiles(messages))
      reason = "unsupported_input";
    reportDecision(reason);
    return undefined;
  }

  // Only trusted deployed callers supply environment identity. The rollout is
  // independent of the historical Pro experiment; disabling it restores the
  // existing moderated Abliteration route.
  let inferenceCyberEnabled = false;
  if (inferenceEnvironment && isInferenceConfigured() && posthog) {
    try {
      inferenceCyberEnabled =
        (await getPostHogFlagWithoutExposure(
          posthog,
          INFERENCE_CYBER_FLAG,
          userId,
          { subscription, subscription_tier: subscription },
        )) === true;
    } catch {
      /* Keep Abliteration on unavailable assignment. */
    }
  }

  if (inferenceCyberEnabled) {
    const baselineModel = selectedModel;
    reportDecision("inference_cyber_rollout", "test", INFERENCE_CYBER_FLAG);
    return {
      key: INFERENCE_CYBER_FLAG,
      variant: "test",
      modelKey: ABLITERATION_MODEL_KEY,
      baselineModel,
      generationStepLimit: 3,
      inferenceCyberEnabled: true,
      selectionSource: "moderation",
      moderationEligible,
      moderationChecked,
    };
  }

  reportDecision("moderated_three_step_default", "test");
  return {
    key: ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
    variant: "test",
    modelKey: ABLITERATION_MODEL_KEY,
    baselineModel: selectedModel,
    generationStepLimit: 3,
    inferenceCyberEnabled,
    selectionSource: "moderation",
    moderationEligible,
    moderationChecked,
  };
}
