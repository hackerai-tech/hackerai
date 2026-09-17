import type { PostHog } from "posthog-node";
import type { UIMessage } from "ai";
import type { SubscriptionTier } from "@/types";
import type { ModelName } from "@/lib/ai/providers";
import {
  ABLITERATION_MODEL_KEY,
  isAbliterationConfigured,
  isAbliterationModel,
} from "@/lib/ai/abliteration";
import {
  isEligibleForAbliteratedModel,
  type AbliteratedAssignment,
} from "./abliterated-model";
import { PAID_FIRST_STEP_ABLITERATED_EXPERIMENT_KEY } from "./abliteration-keys";
import { getPaidFirstStepEnrollment } from "./paid-first-step-enrollment";

/** Expand safe paid first steps while preserving existing moderation/history routes. */
export async function evaluatePaidFirstStepModel(args: {
  posthog: Pick<PostHog, "getFeatureFlag" | "capture"> | null;
  userId: string;
  organizationId?: string;
  subscription: SubscriptionTier;
  mode: "ask" | "agent";
  selectedModel: ModelName;
  moderationEligible: boolean;
  safetyEligible: boolean;
  messages: UIMessage[];
  limitRescue: boolean;
  isAutomaticContinuation?: boolean;
  existingAssignment?: AbliteratedAssignment;
}): Promise<AbliteratedAssignment | undefined> {
  const unchanged = args.existingAssignment;
  if (
    !args.posthog ||
    args.isAutomaticContinuation === true ||
    !args.organizationId ||
    !isAbliterationConfigured() ||
    (args.subscription !== "pro" &&
      args.subscription !== "pro-plus" &&
      args.subscription !== "ultra") ||
    !isEligibleForAbliteratedModel({
      ...args,
      moderationEligible: args.safetyEligible,
    })
  )
    return unchanged;
  try {
    const variant = await args.posthog.getFeatureFlag(
      PAID_FIRST_STEP_ABLITERATED_EXPERIMENT_KEY,
      args.userId,
      {
        sendFeatureFlagEvents: false,
        personProperties: {
          subscription_tier: args.subscription,
          subscription: args.subscription,
        },
      },
    );
    // Check the live flag before stored assignment so disabling it is a kill switch.
    if (variant !== "control" && variant !== "test") return unchanged;
    const enrollment = await getPaidFirstStepEnrollment({
      userId: args.userId,
      organizationId: args.organizationId,
      variant,
      subscription: args.subscription,
    });
    if (!enrollment) {
      args.posthog.capture({
        distinctId: args.userId,
        event: "paid_first_step_enrollment_unavailable",
        properties: {
          experiment_key: PAID_FIRST_STEP_ABLITERATED_EXPERIMENT_KEY,
          mode: args.mode,
          subscription_tier: args.subscription,
          $process_person_profile: false,
        },
      });
      return unchanged;
    }
    const currentRoutingModel = unchanged?.modelKey ?? args.selectedModel;
    const modelKey =
      enrollment.variant === "test" && !isAbliterationModel(currentRoutingModel)
        ? ABLITERATION_MODEL_KEY
        : currentRoutingModel;
    return {
      key: PAID_FIRST_STEP_ABLITERATED_EXPERIMENT_KEY,
      variant: enrollment.variant,
      baselineModel: args.selectedModel,
      modelKey,
      selectionSource: unchanged?.selectionSource ?? "paid_expansion",
      independentHistoryCount: unchanged?.independentHistoryCount,
      moderationEligible: args.moderationEligible,
      paidFirstStep: {
        enrollmentId: enrollment._id,
        enrolledAt: enrollment.enrolled_at,
        baselineRenewalAt: enrollment.baseline_renewal_at,
        stripeSubscriptionId: enrollment.stripe_subscription_id,
        stripeCustomerId: enrollment.stripe_customer_id,
        organizationId: enrollment.organization_id,
        billingInterval: enrollment.billing_interval,
        billingIntervalCount: enrollment.billing_interval_count,
        subscriptionStartedAt: enrollment.subscription_started_at,
        cancelAtPeriodEnd: enrollment.cancel_at_period_end,
        subscriptionTier: enrollment.subscription_tier,
        currentRoutingModel,
        routingChanged: currentRoutingModel !== modelKey,
      },
    };
  } catch {
    // No experiment without a trustworthy enrollment; billing lookup never blocks chat.
    try {
      args.posthog.capture({
        distinctId: args.userId,
        event: "paid_first_step_enrollment_unavailable",
        properties: {
          experiment_key: PAID_FIRST_STEP_ABLITERATED_EXPERIMENT_KEY,
          mode: args.mode,
          subscription_tier: args.subscription,
          $process_person_profile: false,
        },
      });
    } catch {
      /* Best effort. */
    }
    return unchanged;
  }
}
