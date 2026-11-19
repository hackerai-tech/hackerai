import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import {
  classifyProviderOverflowError,
  extractErrorDetails,
  getProviderStatusCode,
  isLocalOpenRouterRequestSizeGuardError,
} from "@/lib/utils/error-utils";

export type ProviderRequestRetryParams = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0]["params"];

export type ProviderRequestSizeRecoveryState = {
  attempted: boolean;
  /** Last observed doStream result, which may return a stream with an error part. */
  lastStreamBoundary?: "stream_returned" | "do_stream_rejected";
  /** Stage of the single admitted size recovery across the run. */
  firstAttemptStage?:
    | "compacting"
    | "compaction_rejected"
    | "cancelled_before_retry"
    | "no_summary"
    | "summary_not_smaller"
    | "committing_replacement"
    | "retry_stream_returned"
    | "retry_rejected";
};

/** Project only finite state for size failures and runs that attempted size recovery. */
export function getProviderRequestSizeRecoveryDiagnostics(
  state: ProviderRequestSizeRecoveryState | undefined,
  statusCode: number | undefined,
) {
  if (statusCode !== 400 && statusCode !== 413 && !state?.attempted) return;
  return {
    request_size_recovery_diagnostic_version: 1,
    request_size_last_stream_boundary:
      state?.lastStreamBoundary ?? "unobserved",
    request_size_first_attempt_stage: state?.firstAttemptStage ?? "no_attempt",
  };
}

/** Only pre-stream rejections are replayable; never replay a partially consumed stream. */
export function withProviderRequestSizeRecovery(
  model: LanguageModel,
  options: {
    state: ProviderRequestSizeRecoveryState;
    abortSignal: AbortSignal;
    compact: () => Promise<string | undefined>;
    commit: (summary: string, retryParams: ProviderRequestRetryParams) => void;
  },
): LanguageModel {
  if (typeof model === "string" || model.specificationVersion !== "v3")
    return model;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ params }) => {
        const state = options.state;
        try {
          const result = await model.doStream(params);
          state.lastStreamBoundary = "stream_returned";
          return result;
        } catch (error) {
          state.lastStreamBoundary = "do_stream_rejected";
          if (
            state.attempted ||
            options.abortSignal.aborted ||
            params.abortSignal?.aborted
          )
            throw error;
          const details = extractErrorDetails(error);
          const status = getProviderStatusCode(details);
          const overflow = classifyProviderOverflowError(error);
          const mediaCode =
            typeof details.providerErrorCode === "string" &&
            /^(?:media|image|file)[_-]/i.test(details.providerErrorCode);
          if (
            !isLocalOpenRouterRequestSizeGuardError(error) &&
            !(
              !mediaCode &&
              overflow !== "media" &&
              (status === 413 || (status === 400 && overflow === "context"))
            )
          )
            throw error;
          // Shared across all model wrappers and SDK/provider retries in this run.
          state.attempted = true;
          state.firstAttemptStage = "compacting";
          let summary: string | undefined;
          try {
            summary = await options.compact();
          } catch (compactionError) {
            state.firstAttemptStage = "compaction_rejected";
            throw compactionError;
          }
          if (options.abortSignal.aborted || params.abortSignal?.aborted)
            state.firstAttemptStage = "cancelled_before_retry";
          options.abortSignal.throwIfAborted();
          params.abortSignal?.throwIfAborted();
          if (!summary) {
            state.firstAttemptStage = "no_summary";
            throw error;
          }
          const prompt: typeof params.prompt = [
            ...params.prompt.filter((message) => message.role === "system"),
            { role: "user", content: [{ type: "text", text: summary }] },
          ];
          const bytes = (value: unknown) =>
            new TextEncoder().encode(JSON.stringify(value)).byteLength;
          if (bytes(prompt) >= bytes(params.prompt)) {
            state.firstAttemptStage = "summary_not_smaller";
            throw error;
          }
          const retryParams = { ...params, prompt };
          state.firstAttemptStage = "committing_replacement";
          options.commit(summary, retryParams);
          // Same model, system, tools, tool choice and provider options. A second
          // rejection (including a lower upstream limit) propagates normally.
          try {
            const result = await model.doStream(retryParams);
            state.lastStreamBoundary = "stream_returned";
            state.firstAttemptStage = "retry_stream_returned";
            return result;
          } catch (retryError) {
            state.lastStreamBoundary = "do_stream_rejected";
            state.firstAttemptStage = "retry_rejected";
            throw retryError;
          }
        }
      },
    },
  });
}
