import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];
type StreamResult = Awaited<
  ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
>;
type Part = StreamResult["stream"] extends ReadableStream<infer P> ? P : never;

/**
 * A direct adapter can throw from its stream reader after a socket failure.
 * The SDK runs onError/onFinish, and therefore the caller's baseline recovery,
 * only for an error part, so convert the throw into one and close the stream.
 */
function errorsAsParts(stream: ReadableStream<Part>): ReadableStream<Part> {
  const reader = stream.getReader();
  let cancelled = false;
  return new ReadableStream<Part>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          reader.releaseLock();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        if (cancelled) return;
        reader.releaseLock();
        controller.enqueue({ type: "error", error });
        controller.close();
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });
}

export function withStreamErrorParts<M extends Model>(model: M): M {
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return { ...result, stream: errorsAsParts(result.stream) };
      },
    },
  }) as M;
}
