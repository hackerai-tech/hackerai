import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

type StreamOptions = Parameters<
  NonNullable<LanguageModelMiddleware["wrapStream"]>
>[0];
type Model = StreamOptions["model"];
type Result = Awaited<ReturnType<Model["doStream"]>>;
type Part = Result["stream"] extends ReadableStream<infer P> ? P : never;
type Usage = Extract<Part, { type: "finish" }>["usage"];

/** A single pre-output fallback; never replay a published tool call or text. */
export function withInferenceFallback(
  primary: Model,
  fallback: Model,
  options: {
    abortSignal: AbortSignal;
    onDiscardedUsage: (usage: Usage) => void;
    prepareFallbackPrompt: (
      prompt: StreamOptions["params"]["prompt"],
    ) => Promise<StreamOptions["params"]["prompt"]>;
  },
) {
  return wrapLanguageModel({
    model: primary,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ params }) => {
        const checkAbort = () => {
          options.abortSignal.throwIfAborted();
          params.abortSignal?.throwIfAborted();
        };
        let reader: ReadableStreamDefaultReader<Part> | undefined;
        let usage: Usage | undefined;
        const buffered: Part[] = [];
        try {
          checkAbort();
          const result = await primary.doStream(params);
          reader = result.stream.getReader();
          while (true) {
            checkAbort();
            const { done, value } = await reader.read();
            if (done) throw new Error("InferenceEmptyResponse");
            if (value.type === "finish") usage = value.usage;
            if (value.type === "error") throw value.error;
            buffered.push(value);
            if (
              (value.type === "text-delta" && value.delta.length > 0) ||
              value.type === "tool-input-start" ||
              value.type === "tool-call"
            )
              break;
          }
          const activeReader = reader;
          return {
            ...result,
            stream: new ReadableStream<Part>({
              async pull(controller) {
                if (buffered.length) {
                  for (const part of buffered.splice(0))
                    controller.enqueue(part);
                  return;
                }
                try {
                  const { done, value } = await activeReader.read();
                  if (done) {
                    activeReader.releaseLock();
                    controller.close();
                  } else controller.enqueue(value);
                } catch (error) {
                  activeReader.releaseLock();
                  controller.error(error);
                }
              },
              async cancel(reason) {
                try {
                  await activeReader.cancel(reason);
                } finally {
                  activeReader.releaseLock();
                }
              },
            }),
          };
        } catch (error) {
          if (reader) {
            try {
              await reader.cancel();
            } catch {
              // An errored stream rejects cancel with its stored error.
              // Cleanup must not prevent the pre-output fallback.
            } finally {
              reader.releaseLock();
            }
          }
          checkAbort();
          if (usage) options.onDiscardedUsage(usage);
          // Keep the primary's native images intact. Only the retained
          // provider's leg pays for its smaller image budget's preprocessing.
          const prompt = await options.prepareFallbackPrompt(params.prompt);
          checkAbort();
          // Provider namespaces are separate; no OpenRouter options or user ID
          // are forwarded to either direct provider.
          const effort = params.providerOptions?.inference?.reasoningEffort;
          return fallback.doStream({
            ...params,
            prompt,
            providerOptions: {
              abliteration: {
                reasoningEffort: effort === "max" ? "max" : "high",
              },
            },
          });
        }
      },
    },
  });
}
