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

export type ProviderStreamTimeoutDetails = {
  phase: "response" | "chunk";
  timeoutMs: number;
  modelId: string;
};

export type ProviderStreamTimeoutOptions = {
  timeoutMs: number;
  onTimeout?: (details: ProviderStreamTimeoutDetails) => void;
};

class ProviderStreamTimeoutError extends Error {
  name = "ProviderStreamTimeoutError";

  constructor(
    message: string,
    readonly phase: ProviderStreamTimeoutDetails["phase"],
  ) {
    super(message);
  }
}

/** Identify a local watchdog failure before a provider response could emit output. */
export const isProviderResponseTimeout = (error: unknown): boolean =>
  error instanceof ProviderStreamTimeoutError && error.phase === "response";

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
          phase: ProviderStreamTimeoutDetails["phase"],
        ): Promise<T> =>
          new Promise((resolve, reject) => {
            const fail = (reason: unknown) => {
              clearTimeout(timer);
              pendingReject = undefined;
              reject(reason);
            };
            const timer = setTimeout(() => {
              const error = new ProviderStreamTimeoutError(
                `Provider ${phase} timed out after ${options.timeoutMs}ms`,
                phase,
              );
              fail(error);
              cancelProvider(error);
              dispose();
              try {
                options.onTimeout?.({
                  phase,
                  timeoutMs: options.timeoutMs,
                  modelId: provider.modelId,
                });
              } catch {
                // Diagnostics must not prevent recovery from a stalled provider.
              }
            }, options.timeoutMs);
            pendingReject = fail;
            operation.then((value) => {
              clearTimeout(timer);
              pendingReject = undefined;
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
          // Also dispose a response that arrives after its request timed out.
          void response.then(
            (result) => {
              if (disposed) void result.stream.cancel().catch(() => undefined);
            },
            () => undefined,
          );
          const result = await waitForProvider(response, "response");
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
