import type { AbliterationRoutingMarker } from "@/lib/experiments/abliteration-history";
import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import type { PostHog } from "posthog-node";
import { calculateRawModelUsageCostDollars } from "@/lib/rate-limit/token-bucket";
import { isAbliterationModel } from "@/lib/ai/abliteration";
import { type AbliteratedAssignment } from "@/lib/experiments/abliterated-model";
import { ABLITERATION_MAX_GENERATION_STEPS } from "@/lib/experiments/abliterated-model-steps";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

type StreamOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type StreamResult = Awaited<ReturnType<StreamOptions["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

type ProviderOutcome =
  | "completed"
  | "error"
  | "aborted"
  | "incomplete"
  | "content_filter"
  | "truncated"
  | "empty";

export type ModelStepRouting = {
  plannedBaselineContinuation?: boolean;
  visionRoute?: boolean;
  fallbackModels?: readonly string[];
};

/** One instance per assistant response; shared across retries and model switches. */
export class AbliteratedModelTelemetry {
  private sequence = 0;
  private readonly totals = {
    provider_outcome_count: 0,
    provider_completed_count: 0,
    provider_error_count: 0,
    provider_aborted_count: 0,
    provider_incomplete_count: 0,
    provider_content_filter_count: 0,
    provider_truncated_count: 0,
    provider_empty_count: 0,
    provider_abliteration_attempt_count: 0,
    provider_baseline_attempt_count: 0,
    provider_continuation_completed_count: 0,
    provider_usage_reported_count: 0,
    provider_input_tokens: 0,
    provider_output_tokens: 0,
    provider_cache_read_tokens: 0,
    provider_reasoning_tokens: 0,
    provider_estimated_cost_dollars: 0,
    provider_duration_ms: 0,
    provider_tool_call_count: 0,
  };
  private exposed = false;
  private pendingRecovery?: { model: string; kind: "error" | "output" };
  private readonly routing = {
    model_routing_telemetry_version: 1 as const,
    planned_baseline_attempt_count: 0,
    vision_route_attempt_count: 0,
    abliterated_provider_error_count: 0,
    baseline_provider_error_count: 0,
    provider_error_recovery_attempt_count: 0,
    provider_error_recovery_served: false,
    provider_error_fallback_served: false,
    output_recovery_attempt_count: 0,
    output_recovery_fallback_served: false,
    upstream_model_fallback_served: false,
  };
  private successfulAbliterationGeneration = false;
  private selectionSource: "moderation" | "history";
  private readonly startedAt = Date.now();
  private readonly properties: Record<string, string | number | boolean>;

  constructor(
    private readonly posthog: Pick<PostHog, "capture"> | null,
    private readonly userId: string,
    args: {
      assignment: AbliteratedAssignment;
      messageId: string;
      chatId: string;
      mode: ChatMode;
      subscription: SubscriptionTier;
      selectedModelOverride?: SelectedModel;
    },
  ) {
    this.selectionSource = args.assignment.selectionSource ?? "moderation";
    this.properties = {
      experiment_key: args.assignment.key,
      experiment_variant: args.assignment.variant,
      [`$feature/${args.assignment.key}`]: args.assignment.variant,
      experiment_request_id: args.messageId,
      message_id: args.messageId,
      chat_id: args.chatId,
      mode: args.mode,
      subscription_tier: args.subscription,
      selected_model_override: args.selectedModelOverride ?? "auto",
      baseline_model: args.assignment.baselineModel,
      assigned_model: args.assignment.modelKey,
      generation_step_limit: ABLITERATION_MAX_GENERATION_STEPS,
      moderation_eligible: this.selectionSource === "moderation",
      selection_source: this.selectionSource,
      independent_history_count: args.assignment.independentHistoryCount ?? 0,
      routing_version: 2,
      assigned_platform_authorization_context: isAbliterationModel(
        args.assignment.modelKey,
      )
        ? "not_appended"
        : "standard",
      telemetry_version: 2,
      $process_person_profile: false,
    };
    this.capture("abliterated_model_eligible", {});
  }

  private capture(event: string, properties: Record<string, unknown>) {
    try {
      this.posthog?.capture({
        distinctId: this.userId,
        event,
        properties: {
          ...this.properties,
          ...properties,
        },
      });
    } catch {
      /* Analytics must never interrupt a response. */
    }
  }

  setMessageId(messageId: string) {
    if (this.properties.message_id === messageId) return;
    this.properties.message_id = messageId;
    this.successfulAbliterationGeneration = false;
    this.capture("abliterated_model_message_linked", {});
  }

  getRoutingMarker(completedResponse: boolean): AbliterationRoutingMarker {
    return {
      version: 1,
      source: this.selectionSource,
      completed: completedResponse && this.successfulAbliterationGeneration,
    };
  }

  /** Request totals include retries and replacement messages; no per-step array. */
  getSummary() {
    return {
      telemetry_version: 2,
      ...this.routing,
      // Planned step/vision selection never establishes a fallback. Evidence
      // must come from a recovering call or an actual upstream fallback model.
      fallback_served:
        this.routing.provider_error_fallback_served ||
        this.routing.output_recovery_fallback_served ||
        this.routing.upstream_model_fallback_served,
      provider_attempt_count: this.sequence,
      provider_pending_count:
        this.sequence - this.totals.provider_outcome_count,
      ...this.totals,
    };
  }

  wrap(
    model: LanguageModel,
    stepIndex: number,
    routing: ModelStepRouting = {},
  ): LanguageModel {
    if (typeof model === "string" || model.specificationVersion !== "v3")
      return model;
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v3",
        wrapStream: async ({ doStream, params }) => {
          const attempt = ++this.sequence;
          const recovery = this.pendingRecovery;
          // A subsequent call is evidence of recovery; an error without another
          // call, or a user-aborted call, is not a fallback attempt.
          const errorRecovery = recovery?.kind === "error";
          const outputRecovery = recovery?.kind === "output";
          const changedRecoveryModel = recovery?.model !== model.modelId;
          if (errorRecovery)
            this.routing.provider_error_recovery_attempt_count++;
          if (outputRecovery) this.routing.output_recovery_attempt_count++;
          if (
            routing.plannedBaselineContinuation &&
            !errorRecovery &&
            !outputRecovery
          )
            this.routing.planned_baseline_attempt_count++;
          if (routing.visionRoute) this.routing.vision_route_attempt_count++;
          if (isAbliterationModel(model.modelId))
            this.totals.provider_abliteration_attempt_count++;
          else this.totals.provider_baseline_attempt_count++;
          const start = Date.now();
          let terminal = false;
          let textCharacters = 0;
          let toolCalls = 0;
          let reasoningCharacters = 0;
          let firstContentMs: number | undefined;
          let responseModel = model.modelId;
          const recordServedRouting = () => {
            if (errorRecovery) {
              this.routing.provider_error_recovery_served = true;
              if (changedRecoveryModel)
                this.routing.provider_error_fallback_served = true;
            }
            if (outputRecovery && changedRecoveryModel)
              this.routing.output_recovery_fallback_served = true;
            if (
              responseModel !== model.modelId &&
              routing.fallbackModels?.includes(responseModel)
            )
              this.routing.upstream_model_fallback_served = true;
          };
          const common = () => ({
            attempt,
            generation_step: stepIndex + 1,
            within_abliteration_step_limit:
              stepIndex < ABLITERATION_MAX_GENERATION_STEPS,
            requested_model: model.modelId,
            response_model: responseModel,
            platform_authorization_context: isAbliterationModel(model.modelId)
              ? "not_appended"
              : "standard",
          });
          const finish = (
            outcome: ProviderOutcome,
            properties: Record<string, unknown> = {},
          ) => {
            if (terminal) return;
            terminal = true;
            const duration = Date.now() - start;
            this.totals.provider_outcome_count++;
            this.totals[`provider_${outcome}_count`]++;
            if (outcome === "completed" || outcome === "aborted") {
              this.pendingRecovery = undefined;
            } else {
              // Preserve the initiating failure across empty/failed retry legs.
              this.pendingRecovery ??= {
                model: model.modelId,
                kind: outcome === "error" ? "error" : "output",
              };
            }
            if (textCharacters > 0 || toolCalls > 0) recordServedRouting();
            if (outcome === "error") {
              if (isAbliterationModel(model.modelId))
                this.routing.abliterated_provider_error_count++;
              else this.routing.baseline_provider_error_count++;
            }
            this.totals.provider_duration_ms += duration;
            this.totals.provider_tool_call_count += toolCalls;
            if (outcome === "completed" && stepIndex > 0)
              this.totals.provider_continuation_completed_count++;
            if (
              typeof properties.estimated_provider_cost_dollars === "number"
            ) {
              this.totals.provider_usage_reported_count++;
              this.totals.provider_estimated_cost_dollars +=
                properties.estimated_provider_cost_dollars;
            }
            for (const key of [
              "input_tokens",
              "output_tokens",
              "cache_read_tokens",
              "reasoning_tokens",
            ] as const) {
              const value = properties[key];
              if (typeof value === "number")
                this.totals[`provider_${key}`] += value;
            }
            if (
              outcome === "completed" &&
              isAbliterationModel(responseModel) &&
              isAbliterationModel(model.modelId)
            )
              this.successfulAbliterationGeneration = true;
            // Keep first-step comparisons and every exceptional outcome. Normal
            // continuation successes are represented by the final run summary.
            if (stepIndex > 0 && outcome === "completed") return;
            this.capture("abliterated_model_provider_outcome", {
              ...common(),
              outcome,
              duration_ms: duration,
              first_content_ms: firstContentMs,
              text_characters: textCharacters,
              reasoning_characters: reasoningCharacters,
              tool_call_count: toolCalls,
              has_text: textCharacters > 0,
              ...properties,
            });
          };
          const expose = () => {
            firstContentMs ??= Date.now() - start;
            recordServedRouting();
            if (this.exposed) return;
            this.exposed = true;
            this.capture("abliterated_model_exposed", {
              ...common(),
              time_to_exposure_ms: Date.now() - this.startedAt,
              exposure_surface: "stream_content",
            });
          };
          let result: StreamResult;
          try {
            result = await doStream();
          } catch (error) {
            finish(params.abortSignal?.aborted ? "aborted" : "error");
            throw error;
          }
          const reader = result.stream.getReader();
          return {
            ...result,
            stream: new ReadableStream<StreamPart>({
              pull: async (controller) => {
                try {
                  const next = await reader.read();
                  if (next.done) {
                    finish(
                      params.abortSignal?.aborted ? "aborted" : "incomplete",
                    );
                    controller.close();
                    return;
                  }
                  const part = next.value;
                  if (part.type === "response-metadata" && part.modelId)
                    responseModel = part.modelId;
                  if (part.type === "text-delta") {
                    textCharacters += part.delta.trim().length;
                    if (part.delta.trim()) expose();
                  }
                  if (part.type === "reasoning-delta")
                    reasoningCharacters += part.delta.length;
                  if (part.type === "tool-call") {
                    toolCalls++;
                    expose();
                  }
                  if (part.type === "error") finish("error");
                  if (part.type === "finish") {
                    finish(
                      part.finishReason.unified === "error"
                        ? "error"
                        : part.finishReason.unified === "content-filter"
                          ? "content_filter"
                          : part.finishReason.unified === "length"
                            ? "truncated"
                            : textCharacters > 0 || toolCalls > 0
                              ? "completed"
                              : "empty",
                      {
                        finish_reason: part.finishReason.unified,
                        input_tokens: part.usage.inputTokens.total,
                        output_tokens: part.usage.outputTokens.total,
                        cache_read_tokens: part.usage.inputTokens.cacheRead,
                        reasoning_tokens: part.usage.outputTokens.reasoning,
                        ...(part.usage.inputTokens.total !== undefined &&
                          part.usage.outputTokens.total !== undefined && {
                            estimated_provider_cost_dollars:
                              calculateRawModelUsageCostDollars({
                                inputTokens: part.usage.inputTokens.total,
                                outputTokens: part.usage.outputTokens.total,
                                cacheReadTokens:
                                  part.usage.inputTokens.cacheRead,
                                modelName: responseModel,
                              }),
                            cost_source: "configured_token_rates",
                          }),
                      },
                    );
                  }
                  controller.enqueue(part);
                } catch (error) {
                  finish(params.abortSignal?.aborted ? "aborted" : "error");
                  controller.error(error);
                }
              },
              cancel: async (reason) => {
                finish("aborted");
                await reader.cancel(reason);
              },
            }),
          };
        },
      },
    });
  }
}
