import type { UIMessageChunk } from "ai";

/** Keep recoverable errors out of the UI after the SDK records them for retry. */
export function createRecoverableProviderErrorFilter<T extends UIMessageChunk>(
  canRecover: () => boolean,
): TransformStream<T, T> {
  return new TransformStream<T, T>({
    transform(chunk, controller) {
      if (chunk.type === "error" && canRecover()) return;
      controller.enqueue(chunk);
    },
  });
}
