import type { PostHog } from "posthog-node";
import type { ModelName } from "@/lib/ai/providers";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";
import { getPostHogFlagWithoutExposure } from "@/lib/posthog/flag-assignment";
import {
  DEEPSEEK_1017_MODEL_KEY,
  DEEPSEEK_1017_SLUG,
} from "./paid-deepseek-1017";

export const MAX_GROK_46_KEY = "max_grok_46_quality_v1";
export const MAX_GROK_46_FEEDBACK_PHASE = "max_grok_46_quality_feedback_v1";
// Reuse the existing routing taxonomy; experiment_key isolates this trial.
export const MAX_GROK_46_EXPOSURE_EVENT = "flash_routing_experiment_exposed";
export const MAX_GROK_46_OUTCOME_EVENT = "paid_model_response_outcome";
export type MaxGrokAssignment = {
  key: typeof MAX_GROK_46_KEY;
  variant: "control" | "test";
  modelKey: ModelName;
  baselineModel: ModelName;
  hasImages: boolean;
};

/** Missing analytics or a disabled flag retains the shipped control policy. */
export async function evaluateMaxGrok46(args: {
  posthog: Pick<PostHog, "getFeatureFlagResult"> | null;
  userId: string;
  subscription: SubscriptionTier;
  mode: ChatMode;
  selectedModelOverride?: SelectedModel;
  hasImages: boolean;
  limitRescue?: boolean;
}): Promise<MaxGrokAssignment | undefined> {
  if (
    !args.posthog ||
    !args.userId ||
    args.mode !== "agent" ||
    args.subscription === "free" ||
    args.selectedModelOverride !== "hackerai-max" ||
    args.limitRescue
  )
    return;
  try {
    const variant = await getPostHogFlagWithoutExposure(
      args.posthog,
      MAX_GROK_46_KEY,
      args.userId,
      { subscription: args.subscription, subscription_tier: args.subscription },
    );
    if (variant !== "control" && variant !== "test") return;
    const baselineModel = args.hasImages
      ? DEEPSEEK_1017_MODEL_KEY
      : "model-glm-5.3";
    return {
      key: MAX_GROK_46_KEY,
      variant,
      baselineModel,
      modelKey: variant === "test" ? "model-grok-4.6" : baselineModel,
      hasImages: args.hasImages,
    };
  } catch {
    return;
  }
}

type Capture = Pick<PostHog, "capture">;
type Outcome = {
  outcome: "success" | "error" | "aborted";
  naturalCompletion: boolean;
  responseMessageId?: string;
  responseModel?: string;
  finishReason?: string;
  abortSource?: string;
  durationMs?: number;
  firstChunkMs?: number;
  recoveryAttempts?: number;
  recoverySucceeded?: boolean;
  handledToolFailures?: number;
  stepLimitReached?: boolean;
  usage?: Record<string, number>;
};

/** One request-scoped recorder survives provider retries; never accepts user content. */
export class MaxModelTelemetry {
  private exposed = false;
  private terminalRecorded = false;
  private attempts = 0;
  private completedSteps = 0;
  private imageToolSteps = 0;
  private toolCalls = 0;
  private startedAt = Date.now();
  private readonly properties;
  hasImageInputs: boolean;
  get hasAssignedExposure() {
    return this.exposed;
  }

  constructor(
    private readonly posthog: Capture | null,
    private readonly userId: string,
    readonly assignment: MaxGrokAssignment,
    args: {
      requestId: string;
      chatId: string;
      subscription: string;
      release?: string;
      environment: string;
    },
  ) {
    this.hasImageInputs = assignment.hasImages;
    this.properties = {
      experiment_key: assignment.key,
      experiment_variant: assignment.variant,
      [`$feature/${assignment.key}`]: assignment.variant,
      experiment_request_id: args.requestId,
      request_id: args.requestId,
      message_id: args.requestId,
      chat_id: args.chatId,
      subscription_tier: args.subscription,
      mode: "agent",
      selected_model_override: "hackerai-max",
      assigned_model: assignment.modelKey,
      baseline_model: assignment.baselineModel,
      initial_input_kind: assignment.hasImages ? "image" : "text_or_pdf",
      experiment_release: args.release ?? "unknown",
      environment: args.environment,
      max_model_measurement_version: 1,
      $process_person_profile: false,
    };
    this.capture("max_model_routing_assigned", {}, "assignment");
  }

  private capture(
    event: string,
    fields: Record<string, unknown>,
    suffix: string,
  ) {
    try {
      this.posthog?.capture({
        distinctId: this.userId,
        event,
        properties: {
          ...this.properties,
          ...fields,
          $insert_id: `${this.properties.request_id}:max-model:${suffix}`,
        },
      });
    } catch {
      /* Measurement cannot interrupt a task. */
    }
  }

  providerStarted(configuredModel: string, hasImages: boolean) {
    this.hasImageInputs ||= hasImages;
    this.attempts++;
    const fields = {
      configured_model: configuredModel,
      has_image_inputs: hasImages,
      provider_attempt: this.attempts,
    };
    this.capture(
      "max_model_provider_started",
      fields,
      `provider:${this.attempts}`,
    );
    const assignedProvider =
      this.assignment.variant === "test"
        ? configuredModel === "x-ai/grok-4.6"
        : configuredModel ===
          (this.hasImageInputs ? DEEPSEEK_1017_SLUG : "z-ai/glm-5.3");
    if (this.exposed || !assignedProvider) return;
    this.exposed = true;
    this.capture(
      MAX_GROK_46_EXPOSURE_EVENT,
      { ...fields, exposure_surface: "provider_request" },
      "exposure",
    );
  }

  providerCompleted(args: {
    responseModel?: string;
    finishReason: string;
    toolCalls: number;
    hasImageToolResults: boolean;
  }) {
    this.completedSteps++;
    this.toolCalls += args.toolCalls;
    if (args.hasImageToolResults) this.imageToolSteps++;
    this.capture(
      "max_model_provider_completed",
      {
        response_model: args.responseModel,
        finish_reason: args.finishReason,
        tool_call_count: args.toolCalls,
        has_image_tool_results: args.hasImageToolResults,
        provider_step: this.completedSteps,
      },
      `step:${this.completedSteps}`,
    );
  }

  recordTerminal(args: Outcome) {
    if (this.terminalRecorded) return;
    this.terminalRecorded = true;
    const usage = args.usage;
    const modelCost = usage?.usage_observed_model_cost_dollars;
    const nonModelCost = usage?.usage_observed_non_model_cost_dollars;
    const observedCost =
      modelCost !== undefined && nonModelCost !== undefined
        ? modelCost + nonModelCost
        : null;
    this.capture(
      MAX_GROK_46_OUTCOME_EVENT,
      {
        message_id: args.responseMessageId ?? this.properties.message_id,
        exposed_to_assigned_model: this.exposed,
        outcome: args.outcome,
        natural_completion: args.naturalCompletion,
        response_model: args.responseModel,
        finish_reason: args.finishReason ?? "unknown",
        abort_source: args.abortSource,
        duration_ms:
          args.durationMs ?? Math.max(0, Date.now() - this.startedAt),
        time_to_first_chunk_ms: args.firstChunkMs,
        provider_attempt_count: this.attempts,
        provider_completed_step_count: this.completedSteps,
        image_tool_step_count: this.imageToolSteps,
        tool_call_count: this.toolCalls,
        provider_recovery_attempts: args.recoveryAttempts ?? 0,
        provider_recovery_succeeded: args.recoverySucceeded,
        handled_tool_failure_count: args.handledToolFailures,
        step_limit_reached: args.stepLimitReached ?? null,
        observed_cost_dollars: observedCost,
        discarded_retry_cost_dollars:
          usage?.usage_discarded_retry_cost_dollars ?? null,
        usage_model_calls_started: usage?.usage_model_calls_started ?? null,
        usage_model_records: usage?.usage_model_records ?? null,
        usage_provider_cost_records: usage?.usage_provider_cost_records ?? null,
        cost_reporting_complete:
          usage !== undefined &&
          this.attempts > 0 &&
          usage.usage_model_calls_started === this.attempts &&
          usage.usage_model_records >= usage.usage_model_calls_started &&
          usage.usage_input_reported_records >=
            usage.usage_model_records + usage.usage_summary_records &&
          usage.usage_cache_read_reported_records >=
            usage.usage_model_records + usage.usage_summary_records,
      },
      "outcome",
    );
  }
}
