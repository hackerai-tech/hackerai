import type { PostHog } from "posthog-node";
import type { ExperimentAnalyticsContext } from "@/lib/analytics/experiment-context";
import type { ModelName } from "@/lib/ai/providers";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

export const PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY =
  "paid_standard_model_quality_v1";
export const PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY =
  "paid_pro_model_quality_v1";
export const PAID_MODEL_QUALITY_EXPOSURE_EVENT =
  "paid_model_quality_experiment_exposed";
export const PAID_MODEL_QUALITY_RUN_EVENT = "paid_model_quality_run_completed";

export type PaidModelQualityRoute = "standard" | "pro";
export type PaidModelQualityExperimentVariant = "control" | "test";

export type PaidModelQualityExperimentAssignment = {
  key:
    | typeof PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY
    | typeof PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY;
  route: PaidModelQualityRoute;
  variant: PaidModelQualityExperimentVariant;
  controlModelKey: ModelName;
  modelKey: ModelName;
};

type EligibleRoute = Pick<
  PaidModelQualityExperimentAssignment,
  "key" | "route" | "controlModelKey"
> & {
  previousModelKey: ModelName;
};

function isTargetSubscription(subscription: SubscriptionTier): boolean {
  return subscription === "pro" || subscription === "pro-plus";
}

export function getEligiblePaidModelQualityRoute({
  mode,
  subscription,
  selectedModel,
}: {
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
}): EligibleRoute | undefined {
  if (!isTargetSubscription(subscription)) return undefined;

  const standardControlModel =
    mode === "agent"
      ? "model-glm-5.3-flash-agent"
      : "model-deepseek-v4-flash-0731";

  if (selectedModel === standardControlModel) {
    return {
      key: PAID_STANDARD_MODEL_QUALITY_EXPERIMENT_KEY,
      route: "standard",
      controlModelKey: standardControlModel,
      previousModelKey: "model-deepseek-v4-pro",
    };
  }

  if (selectedModel === "model-deepseek-v4-pro-0813") {
    return {
      key: PAID_PRO_MODEL_QUALITY_EXPERIMENT_KEY,
      route: "pro",
      controlModelKey: "model-deepseek-v4-pro-0813",
      previousModelKey: "model-grok-4.6-pro",
    };
  }

  return undefined;
}

export async function evaluatePaidModelQualityExperiment({
  posthog,
  userId,
  mode,
  subscription,
  selectedModel,
  requestId,
}: {
  posthog: Pick<PostHog, "evaluateFlags"> | null;
  userId: string;
  mode: ChatMode;
  subscription: SubscriptionTier;
  selectedModel: ModelName;
  requestId?: string;
}): Promise<PaidModelQualityExperimentAssignment | undefined> {
  const eligibleRoute = getEligiblePaidModelQualityRoute({
    mode,
    subscription,
    selectedModel,
  });
  if (!posthog || !eligibleRoute) return undefined;

  try {
    const flags = await posthog.evaluateFlags(userId, {
      flagKeys: [eligibleRoute.key],
    });
    const variant = flags.getFlag(eligibleRoute.key);

    if (variant !== "control" && variant !== "test") {
      return undefined;
    }

    return {
      key: eligibleRoute.key,
      route: eligibleRoute.route,
      variant,
      controlModelKey: eligibleRoute.controlModelKey,
      modelKey:
        variant === "test"
          ? eligibleRoute.previousModelKey
          : eligibleRoute.controlModelKey,
    };
  } catch (error) {
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "warn",
        event: "paid_model_quality_experiment_evaluation_failed",
        service: "model-routing-experiment",
        environment:
          process.env.VERCEL_ENV ??
          process.env.TRIGGER_ENV ??
          process.env.NODE_ENV ??
          "unknown",
        request_id: requestId ?? "unavailable",
        user_id: userId,
        flag_key: eligibleRoute.key,
        experiment_route: eligibleRoute.route,
        error_name: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return undefined;
  }
}

export function getActivePaidModelQualityExperimentAssignment(
  assignment: PaidModelQualityExperimentAssignment | undefined,
  selectedModel: ModelName,
): PaidModelQualityExperimentAssignment | undefined {
  return assignment?.modelKey === selectedModel ? assignment : undefined;
}

export function getPaidModelQualityExperimentContext(
  assignment: PaidModelQualityExperimentAssignment | undefined,
): ExperimentAnalyticsContext | undefined {
  if (!assignment) return undefined;
  return { key: assignment.key, variant: assignment.variant };
}

export function capturePaidModelQualityExperimentExposure({
  posthog,
  userId,
  subscription,
  mode,
  selectedModelOverride,
  selectedModel,
  configuredModel,
  assignment,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  selectedModel: ModelName;
  configuredModel: string;
  assignment?: PaidModelQualityExperimentAssignment;
}): void {
  if (!posthog || !assignment) return;

  posthog.capture({
    distinctId: userId,
    event: PAID_MODEL_QUALITY_EXPOSURE_EVENT,
    properties: {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [`$feature/${assignment.key}`]: assignment.variant,
      experiment_route: assignment.route,
      subscription,
      subscription_tier: subscription,
      mode,
      control_model: assignment.controlModelKey,
      selected_model: selectedModel,
      selected_model_override: selectedModelOverride ?? "auto",
      configured_model: configuredModel,
      exposure_surface: "provider_request",
      $process_person_profile: false,
    },
  });
}

export function capturePaidModelQualityRun({
  posthog,
  userId,
  experiment,
  subscription,
  mode,
  selectedModel,
  configuredModel,
  responseModel,
  outcome,
  finishReason,
  fallbackServed,
  activeModelStreamDurationMs,
  requestToFirstModelChunkMs,
  providerRecoveryAttempts,
  stepLimitReached,
}: {
  posthog: Pick<PostHog, "capture"> | null;
  userId: string;
  experiment?: ExperimentAnalyticsContext;
  subscription: string;
  mode: ChatMode;
  selectedModel: string;
  configuredModel: string;
  responseModel?: string;
  outcome: "success" | "error" | "aborted";
  finishReason?: string;
  fallbackServed?: boolean;
  activeModelStreamDurationMs?: number;
  requestToFirstModelChunkMs?: number;
  providerRecoveryAttempts?: number;
  stepLimitReached?: boolean;
}): void {
  if (!posthog || !experiment) return;

  const successfulRun =
    outcome === "success" &&
    (mode === "ask" || (finishReason === "stop" && stepLimitReached !== true));

  posthog.capture({
    distinctId: userId,
    event: PAID_MODEL_QUALITY_RUN_EVENT,
    properties: {
      experiment_key: experiment.key,
      experiment_variant: experiment.variant,
      [`$feature/${experiment.key}`]: experiment.variant,
      subscription,
      subscription_tier: subscription,
      mode,
      selected_model: selectedModel,
      configured_model: configuredModel,
      ...(responseModel && { response_model: responseModel }),
      outcome,
      successful_run: successfulRun,
      ...(mode === "agent" && { natural_completion: successfulRun }),
      ...(finishReason && { finish_reason: finishReason }),
      ...(fallbackServed !== undefined && {
        fallback_served: fallbackServed,
      }),
      ...(activeModelStreamDurationMs !== undefined && {
        active_model_stream_duration_ms: activeModelStreamDurationMs,
      }),
      ...(requestToFirstModelChunkMs !== undefined && {
        request_to_first_model_chunk_ms: requestToFirstModelChunkMs,
      }),
      ...(providerRecoveryAttempts !== undefined && {
        provider_recovery_attempts: providerRecoveryAttempts,
      }),
      ...(stepLimitReached !== undefined && {
        step_limit_reached: stepLimitReached,
      }),
      $process_person_profile: false,
    },
  });
}
