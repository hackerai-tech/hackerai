import type { UIMessageChunk } from "ai";

/** Chunks that end an attempt for the browser transport. */
const ATTEMPT_TERMINAL_CHUNK_TYPES = new Set(["error", "finish"]);

const isAttemptTerminal = (chunk: UIMessageChunk) =>
  ATTEMPT_TERMINAL_CHUNK_TYPES.has(chunk.type);

/**
 * Hold one model attempt's terminal chunks until its onFinish settles recovery.
 *
 * The SDK publishes a failed attempt's `error`, `finish-step` and `finish`
 * before the attempt's onFinish can decide whether an existing retry runs. The
 * browser transport stops at `error` and starts a short post-finish drain at
 * `finish`, so publishing either first can cut off a recovered answer. From the
 * attempt's first `error` or `finish`, this filter holds that chunk and every
 * later chunk, preserving order:
 *
 * - `discard()` once the owning onFinish has actually scheduled its retry: the
 *   held `error`/`finish` chunks are dropped and everything else (step ends,
 *   partial output, metadata) is published. Later terminal chunks from this
 *   attempt are dropped the same way.
 * - `release()` when there is no recovery (success, declined or exhausted):
 *   everything is published unchanged. Stream end releases anything still
 *   unsettled, so a terminal chunk is never dropped without a scheduled retry.
 *
 * Settling is one-shot. Create one deferral per attempt; never share it.
 *
 * `publishImmediately` names an `error` that can never be recovered and must
 * be shown at once (a trusted local safety-read failure). When it returns true
 * for an arriving `error`, the attempt is released then and there.
 */
export function createProviderErrorDeferral(
  options: { publishImmediately?: () => boolean } = {},
) {
  let settlement: "pending" | "released" | "discarded" = "pending";
  let held: UIMessageChunk[] | undefined;
  let publish: ((chunk: UIMessageChunk) => void) | undefined;
  let filterCreated = false;

  const settle = (next: "released" | "discarded") => {
    if (settlement !== "pending") return;
    settlement = next;
    const chunks = held ?? [];
    held = undefined;
    for (const chunk of chunks) {
      if (next === "discarded" && isAttemptTerminal(chunk)) continue;
      publish?.(chunk);
    }
  };

  return {
    /** Create the filter for this deferral's single attempt stream. */
    filter<T extends UIMessageChunk>(): TransformStream<T, T> {
      if (filterCreated)
        throw new Error("A provider error deferral owns one attempt stream.");
      filterCreated = true;
      return new TransformStream<T, T>({
        start(controller) {
          publish = (chunk) => {
            try {
              controller.enqueue(chunk as T);
            } catch {
              // The consumer may already have canceled the stream.
            }
          };
        },
        transform(chunk, controller) {
          if (
            settlement === "pending" &&
            chunk.type === "error" &&
            options.publishImmediately?.()
          ) {
            settle("released");
            controller.enqueue(chunk);
          } else if (held) held.push(chunk);
          else if (settlement === "pending" && isAttemptTerminal(chunk))
            held = [chunk];
          else if (settlement === "discarded" && isAttemptTerminal(chunk))
            return;
          else controller.enqueue(chunk);
        },
        flush() {
          settle("released");
        },
      });
    },
    release: () => settle("released"),
    discard: () => settle("discarded"),
  };
}
