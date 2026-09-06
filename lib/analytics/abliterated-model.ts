import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import type { PostHog } from "posthog-node";
import { calculateRawModelUsageCostDollars } from "@/lib/rate-limit/token-bucket";
import type { AbliteratedAssignment } from "@/lib/experiments/abliterated-model";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types";

type StreamOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type StreamResult = Awaited<ReturnType<StreamOptions["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/** One instance per assistant response; shared across retries and model switches. */
export class AbliteratedModelTelemetry {
  private sequence = 0;
  private exposed = false;
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
      moderation_eligible: true,
      telemetry_version: 1,
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
    this.capture("abliterated_model_message_linked", {});
  }

  wrap(model: LanguageModel): LanguageModel {
    if (typeof model === "string" || model.specificationVersion !== "v3")
      return model;
    return wrapLanguageModel({
      model,
      middleware: {
        specificationVersion: "v3",
        wrapStream: async ({ doStream, params }) => {
          const attempt = ++this.sequence;
          const start = Date.now();
          let terminal = false;
          let textCharacters = 0;
          let toolCalls = 0;
          let reasoningCharacters = 0;
          let firstContentMs: number | undefined;
          let responseModel = model.modelId;
          const common = () => ({
            attempt,
            requested_model: model.modelId,
            response_model: responseModel,
          });
          const finish = (
            outcome: string,
            properties: Record<string, unknown> = {},
          ) => {
            if (terminal) return;
            terminal = true;
            this.capture("abliterated_model_provider_outcome", {
              ...common(),
              outcome,
              duration_ms: Date.now() - start,
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
            if (this.exposed) return;
            this.exposed = true;
            this.capture("abliterated_model_exposed", {
              ...common(),
              time_to_exposure_ms: Date.now() - this.startedAt,
              exposure_surface: "stream_content",
            });
          };
          this.capture("abliterated_model_provider_attempt", common());
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
