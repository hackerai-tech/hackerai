import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";

type StreamResult = Awaited<
  ReturnType<
    Parameters<
      NonNullable<LanguageModelMiddleware["wrapStream"]>
    >[0]["doStream"]
  >
>;
type StreamPart =
  StreamResult["stream"] extends ReadableStream<infer T> ? T : never;

export const AGENT_PROVIDER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// Allow two idle windows of provider work, while leaving time for recovery
// within a child's 15-minute active runtime budget.
export const AGENT_PROVIDER_TOTAL_TIMEOUT_MS =
  2 * AGENT_PROVIDER_IDLE_TIMEOUT_MS;

type ProviderStreamOperation = "response" | "chunk";

export type ProviderStreamTimeoutDetails = {
  phase: ProviderStreamOperation | "total";
  timeoutMs: number;
  modelId: string;
};

export type ProviderStreamTimeoutOptions = {
  timeoutMs: number;
  /** Accumulated provider I/O time per request; excludes downstream pauses. */
  totalTimeoutMs?: number;
  onTimeout?: (details: ProviderStreamTimeoutDetails) => void;
};

class ProviderStreamTimeoutError extends Error {
  name = "ProviderStreamTimeoutError";

  constructor(
    message: string,
    readonly phase: ProviderStreamTimeoutDetails["phase"],
    readonly operation: ProviderStreamOperation,
  ) {
    super(message);
  }
}

/** Identify a local watchdog failure before a provider response could emit output. */
export const isProviderResponseTimeout = (error: unknown): boolean =>
  error instanceof ProviderStreamTimeoutError && error.operation === "response";

/** Bound provider I/O without timing tool execution or durable approval waits. */
export function withProviderStreamTimeout(
  model: LanguageModel,
  options: ProviderStreamTimeoutOptions,
): LanguageModel {
  if (typeof model === "string" || model.specificationVersion !== "v3") {
    return model;
  }

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ model: provider, params }) => {
        const controller = new AbortController();
        let pendingReject: ((reason: unknown) => void) | undefined;
        let reader: ReadableStreamDefaultReader<StreamPart> | undefined;
        let disposed = false;
        let providerElapsedMs = 0;

        const dispose = () => {
          disposed = true;
          params.abortSignal?.removeEventListener("abort", onAbort);
        };
        const cancelProvider = (reason: unknown) => {
          controller.abort(reason);
          // A broken provider must not block timeout settlement on cancellation.
          void reader?.cancel(reason).catch(() => undefined);
        };
        const onAbort = () => {
          const reason = params.abortSignal?.reason;
          pendingReject?.(reason);
          cancelProvider(reason);
          dispose();
        };

        // Each read gets its own timer and rejection handler. Reusing a single
        // never-settled Promise.race branch retains one handler per streamed chunk.
        const waitForProvider = <T>(
          operation: Promise<T>,
          operationPhase: ProviderStreamOperation,
        ): Promise<T> =>
          new Promise((resolve, reject) => {
            const startedAt = performance.now();
            const remainingMs =
              options.totalTimeoutMs === undefined
                ? Infinity
                : Math.max(0, options.totalTimeoutMs - providerElapsedMs);
            const phase =
              remainingMs <= options.timeoutMs ? "total" : operationPhase;
            const timeoutMs =
              phase === "total" ? options.totalTimeoutMs! : options.timeoutMs;
            let settled = false;
            const settle = () => {
              if (settled) return false;
              settled = true;
              providerElapsedMs += performance.now() - startedAt;
              clearTimeout(timer);
              pendingReject = undefined;
              return true;
            };
            const fail = (reason: unknown) => {
              if (!settle()) return;
              reject(reason);
            };
            const expire = () => {
              if (settled) return;
              const error = new ProviderStreamTimeoutError(
                `Provider ${phase} timed out after ${timeoutMs}ms`,
                phase,
                operationPhase,
              );
              fail(error);
              cancelProvider(error);
              dispose();
              try {
                options.onTimeout?.({
                  phase,
                  timeoutMs,
                  modelId: provider.modelId,
                });
              } catch {
                // Diagnostics must not prevent recovery from a stalled provider.
              }
            };
            const waitMs = Math.min(options.timeoutMs, remainingMs);
            const timer = setTimeout(expire, waitMs);
            pendingReject = fail;
            operation.then((value) => {
              // A ready chunk must not outrun an overdue timer after a busy
              // event loop, or repeatedly refill an exhausted total budget.
              if (performance.now() - startedAt >= waitMs) {
                expire();
                return;
              }
              if (!settle()) return;
              resolve(value);
            }, fail);
          });

        params.abortSignal?.throwIfAborted();
        params.abortSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          const response = Promise.resolve(
            provider.doStream({
              ...params,
              abortSignal: controller.signal,
            }),
          );
          const pendingResponse = waitForProvider(response, "response");
          // Also dispose a response that arrives after its request timed out.
          void response.then(
            (result) => {
              if (disposed) void result.stream.cancel().catch(() => undefined);
            },
            () => undefined,
          );
          const result = await pendingResponse;
          controller.signal.throwIfAborted();
          reader = result.stream.getReader();
          const sourceReader = reader;
          return {
            ...result,
            stream: new ReadableStream<StreamPart>(
              {
                async pull(output) {
                  try {
                    controller.signal.throwIfAborted();
                    const next = await waitForProvider(
                      sourceReader.read(),
                      "chunk",
                    );
                    if (next.done) {
                      dispose();
                      sourceReader.releaseLock();
                      output.close();
                    } else {
                      output.enqueue(next.value);
                    }
                  } catch (error) {
                    dispose();
                    if (error instanceof ProviderStreamTimeoutError) {
                      // The SDK routes provider error parts through onError and
                      // UI onFinish. A raw stream rejection skips that recovery.
                      output.enqueue({ type: "error", error });
                      output.close();
                    } else {
                      output.error(error);
                    }
                  }
                },
                cancel(reason) {
                  pendingReject?.(reason);
                  cancelProvider(reason);
                  dispose();
                },
              },
              { highWaterMark: 0 },
            ),
          };
        } catch (error) {
          dispose();
          throw error;
        }
      },
    },
  });
}
