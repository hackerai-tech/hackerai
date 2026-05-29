import { fetchWithErrorHandlers } from "@/lib/utils";
import { AGENT_UI_STREAM_ID } from "@/trigger/stream-ids";
import { createToolInputDedupFilter } from "./agent-long-tool-input-dedup";

/**
 * `fetch` adapter for "agent-long" mode used by the chat transport.
 *
 *   1. POST the request body to /api/agent-long, which triggers a durable
 *      trigger.dev task and returns { runId, publicAccessToken }.
 *   2. Subscribe to the task's "ui" metadata stream (Vercel AI SDK
 *      UIMessage chunks the task emitted).
 *   3. Re-encode each chunk as an SSE `data: ...\n\n` frame so the caller's
 *      `useChat` consumes it identically to a normal streaming response.
 *
 * On reconnect (page reload while a run is still executing), useChat fires
 * a GET against the configured reconnect URL; we route that through
 * `resumeAgentLongStream`, which fetches the active runId from
 * /api/agent-long/resume and pipes the same trigger.dev stream. Trigger.dev
 * streams are durable for 28 days, so a fresh subscription replays every
 * chunk from the beginning — useChat reconstructs the in-progress
 * assistant turn without needing a client-side cursor.
 */
type RunHandle = { runId: string; publicAccessToken: string };

const sseHeaders: HeadersInit = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
};

// Only truly failed/terminated statuses warrant an immediate abort — the
// task died and no `finish` chunk will ever arrive. Do NOT include
// "COMPLETED" here: a successful run still has stream chunks (including
// `finish`) in flight when the status event lands, and breaking early
// causes a race that closes the frontend stream prematurely.
const TERMINAL_RUN_STATUSES = new Set([
  "FAILED",
  "CRASHED",
  "CANCELED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

// Maximum time to wait for the first UI stream chunk. Once the task is
// executing, the task-side heartbeat keeps the stream below this idle window.
// If setup or Trigger queueing stalls before the "ui" stream produces data,
// this guarantees useChat eventually exits streaming state.
const STREAM_TIMEOUT_MS = 5 * 60 * 1000;
const STREAM_IDLE_TIMEOUT_SECONDS = STREAM_TIMEOUT_MS / 1000;

const buildSSEResponseFromRun = (
  { runId, publicAccessToken }: RunHandle,
  signal?: AbortSignal,
): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let readAbortController: AbortController | undefined;
      let statusSubscription: { unsubscribe?: () => void } | undefined;
      let userAborted = false;

      // Always close with an abort rather than controller.error() so useChat
      // reliably exits streaming state even when subscription throws.
      const sendAbortAndClose = () => {
        if (closed) return;
        closed = true;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "abort" })}\n\n`),
          );
        } catch {
          // controller may already be closed
        }
        try {
          controller.close();
        } catch {
          // ignore if already closed
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by sendAbortAndClose
        }
      };

      // Timeout guard: if the subscription hangs (e.g. task failed before
      // registering the stream), force-close after STREAM_TIMEOUT_MS.
      const timeoutId = setTimeout(() => {
        readAbortController?.abort();
        sendAbortAndClose();
      }, STREAM_TIMEOUT_MS);

      // Short-circuit if the consumer already aborted before we got here.
      if (signal?.aborted) {
        clearTimeout(timeoutId);
        sendAbortAndClose();
        return;
      }

      const onAbort = () => {
        userAborted = true;
        readAbortController?.abort();
        sendAbortAndClose();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const { streams, runs, auth } = await import("@trigger.dev/sdk");

        await auth.withAuth({ accessToken: publicAccessToken }, async () => {
          readAbortController = new AbortController();
          if (signal?.aborted) {
            userAborted = true;
            readAbortController.abort();
            return;
          }

          // Monitor run failure separately from the UI stream. Reading the
          // stream directly avoids a race where the mixed run+stream
          // subscription can discover the stream late and replay chunks only
          // at completion.
          statusSubscription = runs.subscribeToRun(runId, {
            skipColumns: ["payload", "output"],
          });
          const statusMonitor = (async () => {
            for await (const run of statusSubscription as AsyncIterable<{
              status?: string;
            }>) {
              const status = run.status;
              if (status && TERMINAL_RUN_STATUSES.has(status)) {
                readAbortController?.abort();
                break;
              }
            }
          })().catch(() => undefined);

          const uiStream = await streams.read<unknown>(
            runId,
            AGENT_UI_STREAM_ID,
            {
              signal: readAbortController.signal,
              timeoutInSeconds: STREAM_IDLE_TIMEOUT_SECONDS,
            },
          );

          // text-delta and reasoning-delta chunks are emitted per-token and
          // can number in the thousands for long tasks. Forwarding each one
          // as a separate SSE frame causes the browser to process thousands
          // of React state updates in rapid succession, freezing the UI.
          // We buffer consecutive delta chunks and flush them as a single
          // merged chunk, reducing ~9k events to a few hundred.
          const DELTA_FLUSH_COUNT = 50; // flush after this many buffered deltas
          const DELTA_FLUSH_MS = 30; // or after this many ms (live streaming)

          type DeltaBatch = {
            type: "text-delta" | "reasoning-delta";
            id: string;
            delta: string;
          };
          const deltaBuffers = new Map<string, DeltaBatch>();
          let batchedDeltaCount = 0;
          let deltaFlushTimer: ReturnType<typeof setTimeout> | null = null;
          const toolInputDedup = createToolInputDedupFilter();

          const flushDeltaBuffers = () => {
            if (deltaFlushTimer !== null) {
              clearTimeout(deltaFlushTimer);
              deltaFlushTimer = null;
            }
            if (deltaBuffers.size === 0) return;
            for (const batch of deltaBuffers.values()) {
              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(batch)}\n\n`),
                );
              } catch {
                // controller may already be closed (e.g. timer fired after error)
              }
            }
            deltaBuffers.clear();
            batchedDeltaCount = 0;
          };

          // Race stream.next() against the consumer's abort signal so Stop
          // closes the local stream in one tick, even when the LLM is mid-step
          // and no chunks are flowing.
          const abortSentinel = Symbol("aborted");
          const abortPromise = new Promise<typeof abortSentinel>((resolve) => {
            if (!signal) return; // never resolves — Promise.race ignores it
            signal.addEventListener("abort", () => resolve(abortSentinel), {
              once: true,
            });
          });

          let sawTerminalChunk = false;
          let firstEventReceived = false;
          const iter = uiStream[Symbol.asyncIterator]();
          while (true) {
            const next = await Promise.race([iter.next(), abortPromise]);
            if (next === abortSentinel) {
              userAborted = true;
              break;
            }
            if (next.done) break;
            const chunk = next.value;

            // Disarm the "no first event" timeout once the UI stream is
            // proven live. Without this, a run longer than STREAM_TIMEOUT_MS
            // would have its stream force-closed mid-execution.
            if (!firstEventReceived) {
              firstEventReceived = true;
              clearTimeout(timeoutId);
            }

            if (
              typeof chunk !== "object" ||
              chunk === null ||
              !("type" in chunk)
            ) {
              continue;
            }

            const chunkType = (chunk as { type?: string }).type;
            const chunkId = (chunk as { id?: string }).id;
            const chunkDelta = (chunk as { delta?: string }).delta;

            if (
              (chunkType === "text-delta" || chunkType === "reasoning-delta") &&
              typeof chunkId === "string" &&
              typeof chunkDelta === "string"
            ) {
              const key = `${chunkType}:${chunkId}`;
              const existing = deltaBuffers.get(key);
              if (existing) {
                existing.delta += chunkDelta;
              } else {
                deltaBuffers.set(key, {
                  type: chunkType as "text-delta" | "reasoning-delta",
                  id: chunkId,
                  delta: chunkDelta,
                });
              }
              batchedDeltaCount++;
              if (batchedDeltaCount >= DELTA_FLUSH_COUNT) {
                flushDeltaBuffers();
              } else if (deltaFlushTimer === null) {
                deltaFlushTimer = setTimeout(flushDeltaBuffers, DELTA_FLUSH_MS);
              }
              continue;
            }

            // Non-delta chunk: flush any buffered deltas first so ordering
            // is preserved (e.g. text-delta before tool-input-start).
            flushDeltaBuffers();

            if (
              toolInputDedup.shouldDrop(
                chunk as { type?: string; toolCallId?: string },
              )
            ) {
              continue;
            }

            if (!closed) {
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
              );
            }
            // finish / abort / error are the last chunks useChat needs.
            if (
              chunkType === "finish" ||
              chunkType === "abort" ||
              chunkType === "error"
            ) {
              sawTerminalChunk = true;
              break;
            }
          }

          // Flush any deltas that didn't trigger a count- or timer-based flush.
          flushDeltaBuffers();

          if (userAborted) {
            // Release the trigger.dev subscription so it doesn't keep
            // streaming chunks into a dead controller.
            await iter.return?.(undefined).catch(() => undefined);
          }

          if (!sawTerminalChunk) {
            // Subscription ended without a terminal UI chunk — run crashed,
            // was canceled, or failed before registering the stream.
            sendAbortAndClose();
          }

          statusSubscription?.unsubscribe?.();
          void statusMonitor;
        });

        // Normal close path (sawTerminalChunk = true exits loop above).
        clearTimeout(timeoutId);
        close();
      } catch {
        clearTimeout(timeoutId);
        // Always send an abort on error so useChat cleans up.
        sendAbortAndClose();
      } finally {
        signal?.removeEventListener("abort", onAbort);
        statusSubscription?.unsubscribe?.();
      }
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders });
};

export const fetchAgentLongStream = async (
  init: RequestInit | undefined,
): Promise<Response> => {
  const startResponse = await fetchWithErrorHandlers("/api/agent-long", init);
  if (!startResponse.ok) return startResponse;

  const handle: RunHandle = await startResponse.json();
  return buildSSEResponseFromRun(handle, init?.signal ?? undefined);
};

export const resumeAgentLongStream = async (
  url: string,
  init: RequestInit | undefined,
): Promise<Response> => {
  // useChat's reconnectToStream signals "nothing to resume" by treating a
  // 204 as null. /api/agent-long/resume returns 204 when the chat has no
  // active run (or the stored run hit a terminal state); pass that through.
  const response = await fetchWithErrorHandlers(url, {
    ...init,
    method: "GET",
  });
  if (response.status === 204) return response;
  if (!response.ok) return response;

  const handle: RunHandle = await response.json();
  return buildSSEResponseFromRun(handle, init?.signal ?? undefined);
};
