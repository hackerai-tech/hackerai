import {
  INFERENCE_CYBER_PREVIEW_FLAG,
  isInferenceConfigured,
} from "@/lib/ai/inference";
import { resolvePaidProAutoModel } from "@/lib/ai/paid-model-routing";
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
} from "./abliteration-keys";
export {
  ABLITERATED_EXPERIMENT_KEY,
  ABLITERATED_MAX_EXPERIMENT_KEY,
  ABLITERATED_PAID_FIRST_STEP_KEY,
  ABLITERATED_PAID_MODERATED_DEFAULT_KEY,
  ABLITERATED_PAID_THREE_STEPS_KEY,
  ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
  ABLITERATED_PRO_THREE_STEPS_KEY,
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
    | typeof ABLITERATED_PRO_THREE_STEPS_KEY;
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
  allowsAbliterationContinuation = false,
  newUserTurn = false,
  messages,
  limitRescue = false,
  diagnosticContext,
  previewEnvironment = false,
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
  newUserTurn?: boolean;
  messages: UIMessage[];
  limitRescue?: boolean;
  diagnosticContext?: { chatId: string; requestId: string; logAll?: boolean };
  previewEnvironment?: boolean;
}): Promise<AbliteratedAssignment | undefined> {
  const providerConfigured = isAbliterationConfigured();
  const proThreeStepsEligible =
    subscription === "pro" &&
    !moderationEligible &&
    moderationChecked &&
    allowsAbliterationContinuation &&
    newUserTurn;
  const reportDecision = (reason: string, variant?: string) => {
    if (!diagnosticContext?.logAll) return;
    try {
      phLogger.info("Abliteration assignment decision", {
        userId,
        chatId: diagnosticContext.chatId,
        requestId: diagnosticContext.requestId,
        experiment_key: proThreeStepsEligible
          ? ABLITERATED_PRO_THREE_STEPS_KEY
          : ABLITERATED_PAID_MODERATED_THREE_STEPS_DEFAULT_KEY,
        mode,
        subscription_tier: subscription,
        selected_model_override: selectedModelOverride,
        moderation_eligible: moderationEligible,
        moderation_checked: moderationChecked,
        continuation_moderation_allowed: allowsAbliterationContinuation,
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
      moderationEligible: moderationEligible || proThreeStepsEligible,
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

  // Only trusted runtime callers supply Preview identity. Missing flags, keys
  // and evaluation errors retain the existing provider route.
  let inferenceCyberEnabled = false;
  if (previewEnvironment && isInferenceConfigured() && posthog) {
    try {
      inferenceCyberEnabled =
        (await getPostHogFlagWithoutExposure(
          posthog,
          INFERENCE_CYBER_PREVIEW_FLAG,
          userId,
          { subscription, subscription_tier: subscription },
        )) === true;
    } catch {
      /* Keep Abliteration on unavailable assignment. */
    }
  }

  if (proThreeStepsEligible && posthog) {
    try {
      const variant = await getPostHogFlagWithoutExposure(
        posthog,
        ABLITERATED_PRO_THREE_STEPS_KEY,
        userId,
        { subscription, subscription_tier: subscription },
      );
      // Only explicit variants enroll. Off, missing and legacy boolean flags
      // must not create a control cohort or silently enable treatment.
      if (variant === "control" || variant === "test") {
        // Resolve the shipped route before enrollment locks subsequent policies.
        // Both control and treatment's later steps must use today's baseline.
        const baselineModel = resolvePaidProAutoModel({
          userId,
          subscription,
          selectedModel,
          selectedModelOverride,
          limitRescue,
        });
        reportDecision("pro_three_steps", variant);
        return {
          key: ABLITERATED_PRO_THREE_STEPS_KEY,
          variant,
          modelKey: variant === "test" ? ABLITERATION_MODEL_KEY : baselineModel,
          baselineModel,
          generationStepLimit: 3,
          inferenceCyberEnabled: variant === "test" && inferenceCyberEnabled,
          // Historical source label for unmoderated paid routing; the step
          // budget is carried separately by generationStepLimit.
          selectionSource: "paid_first_step",
          moderationEligible: false,
          moderationChecked,
        };
      }
      reportDecision("pro_three_steps_flag_off");
    } catch {
      reportDecision("pro_three_steps_flag_error");
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
    inferenceCyberEnabled,
    selectionSource: "moderation",
    moderationEligible,
    moderationChecked,
  };
}
