import { randomUUID } from "node:crypto";
import {
  createUIMessageStream,
  type UIMessage,
  type InferUIMessageChunk,
} from "ai";
import { isCancellationError } from "@/lib/utils/error-utils";

/** Publish matched Agent Stop as abort, preserving every unrelated UI error. */
export function createAgentUiMessageStream<MESSAGE extends UIMessage>({
  abortSignal,
  ...options
}: Pick<
  Parameters<typeof createUIMessageStream<MESSAGE>>[0],
  "execute" | "onError"
> & {
  abortSignal: AbortSignal;
}) {
  // The SDK always makes an error chunk from onError's returned string. Keep a
  // private per-stream marker until the publication boundary instead of an empty
  // string that readUIMessageStream would turn into Error("") on the client.
  const cancellationMarker = `hackerai-cancel:${randomUUID()}`;
  const formatError = (error: unknown) =>
    options.onError?.(error) ?? "An error occurred.";
  const stream = createUIMessageStream<MESSAGE>({
    ...options,
    // Callers may use writer.onError for tool error text. Keep the marker
    // private to the SDK's outer error handler, never in caller-written data.
    execute: ({ writer }) =>
      options.execute({
        writer: {
          ...writer,
          onError: (error) =>
            isCancellationError(error, abortSignal) ? "" : formatError(error),
        },
      }),
    onError: (error) =>
      isCancellationError(error, abortSignal)
        ? cancellationMarker
        : formatError(error),
  });
  return stream.pipeThrough(
    new TransformStream<
      InferUIMessageChunk<MESSAGE>,
      InferUIMessageChunk<MESSAGE>
    >({
      transform(chunk, controller) {
        controller.enqueue(
          chunk.type === "error" &&
            "errorText" in chunk &&
            chunk.errorText === cancellationMarker
            ? { type: "abort" }
            : chunk,
        );
      },
    }),
  );
}
