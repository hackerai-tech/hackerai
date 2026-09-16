import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import {
  extractOpenRouterMetadata,
  extractOpenRouterMetadataFromError,
  type OpenRouterModelMetadata,
} from "@/lib/api/openrouter-metadata";

type StreamOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type StreamResult = Awaited<ReturnType<StreamOptions["doStream"]>>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

export interface ProviderModelHistoryEntry {
  // Assigned by the request logger; retries can share a generation step.
  call_index?: number;
  timestamp: string;
  generation_step: number;
  configured: string;
  requested: string;
  provider: string;
  actual?: string;
  upstream_provider?: string;
  response_id?: string;
  openrouter_generation_id?: string;
  openrouter_request_id?: string;
  openrouter_attempts?: OpenRouterModelMetadata["openrouter_attempts"];
  outcome: "pending" | "completed" | "error" | "aborted" | "incomplete";
  finish_reason?: string;
  duration_ms?: number;
}

const identifier = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 512
    ? value
    : undefined;

/**
 * Observe actual provider calls, beneath retry/recovery middleware. The logger
 * retains the entry by reference so terminal logs include its latest state.
 * Only allowlisted routing identifiers are retained, never request/response
 * bodies, headers, tool arguments, or raw errors.
 */
export function withProviderModelHistory(
  model: LanguageModel,
  options: {
    configured: string;
    generationStep: number;
    onStart: (entry: ProviderModelHistoryEntry) => void;
  },
): LanguageModel {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    return model;
  }

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream, params }) => {
        const startedAt = Date.now();
        const entry: ProviderModelHistoryEntry = {
          timestamp: new Date(startedAt).toISOString(),
          generation_step: options.generationStep,
          configured: options.configured,
          requested: model.modelId,
          provider: model.provider,
          outcome: "pending",
        };
        try {
          options.onStart(entry);
        } catch {
          // Observability must not interrupt generation.
        }
        const isOpenRouter = model.provider.split(".")[0] === "openrouter";
        const routing = (metadata: OpenRouterModelMetadata) => {
          const upstream = identifier(metadata.provider_name);
          const actual = identifier(metadata.openrouter_selected_model);
          const generationId = identifier(metadata.openrouter_generation_id);
          const requestId = identifier(metadata.openrouter_request_id);
          if (upstream) entry.upstream_provider = upstream;
          if (actual && !entry.actual) entry.actual = actual;
          if (generationId) entry.openrouter_generation_id = generationId;
          if (requestId) entry.openrouter_request_id = requestId;
          if (metadata.openrouter_attempts) {
            entry.openrouter_attempts = metadata.openrouter_attempts.map(
              ({ provider, model: requested, status, selected }) => ({
                provider: identifier(provider),
                model: identifier(requested),
                status,
                selected,
              }),
            );
          }
        };
        const settle = (outcome: ProviderModelHistoryEntry["outcome"]) => {
          if (entry.outcome !== "pending") return;
          entry.outcome = outcome;
          entry.duration_ms = Date.now() - startedAt;
          params.abortSignal?.removeEventListener("abort", onAbort);
        };
        const onAbort = () => settle("aborted");
        params.abortSignal?.addEventListener("abort", onAbort, { once: true });
        if (params.abortSignal?.aborted) onAbort();
        const onError = (error: unknown) => {
          if (isOpenRouter) routing(extractOpenRouterMetadataFromError(error));
          settle(params.abortSignal?.aborted ? "aborted" : "error");
        };

        let result: StreamResult;
        try {
          result = await doStream();
        } catch (error) {
          onError(error);
          throw error;
        }
        if (isOpenRouter) {
          routing(extractOpenRouterMetadata({ response: result.response }));
        }
        const reader = result.stream.getReader();
        return {
          ...result,
          stream: new ReadableStream<StreamPart>(
            {
              async pull(controller) {
                try {
                  const { value, done } = await reader.read();
                  if (done) {
                    settle("incomplete");
                    reader.releaseLock();
                    controller.close();
                    return;
                  }
                  if (value.type === "response-metadata") {
                    const actual = identifier(value.modelId);
                    const responseId = identifier(value.id);
                    if (actual) entry.actual = actual;
                    if (responseId) entry.response_id = responseId;
                    if (isOpenRouter) {
                      routing(extractOpenRouterMetadata({ response: value }));
                    }
                  } else if (value.type === "finish") {
                    if (isOpenRouter) {
                      routing(
                        extractOpenRouterMetadata({
                          providerMetadata: value.providerMetadata,
                        }),
                      );
                    }
                    entry.finish_reason = value.finishReason.unified;
                    settle(
                      value.finishReason.unified === "error"
                        ? "error"
                        : "completed",
                    );
                  } else if (value.type === "error") {
                    onError(value.error);
                  }
                  controller.enqueue(value);
                } catch (error) {
                  onError(error);
                  reader.releaseLock();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                settle("aborted");
                try {
                  await reader.cancel(reason);
                } finally {
                  reader.releaseLock();
                }
              },
            },
            { highWaterMark: 0 },
          ),
        };
      },
    },
  });
}
