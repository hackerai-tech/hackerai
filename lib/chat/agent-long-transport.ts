import { fetchWithErrorHandlers } from "@/lib/utils";
import { AGENT_UI_STREAM_ID } from "@/trigger/stream-ids";
import {
  AGENT_API_ENDPOINT,
  AGENT_STATUS_ENDPOINT,
  LEGACY_AGENT_RESUME_ENDPOINT,
  LEGACY_AGENT_STATUS_ENDPOINT,
} from "@/lib/api/agent-endpoints";
import { createToolInputDedupFilter } from "./agent-long-tool-input-dedup";
import {
  readTriggerRunStream,
  retrieveTriggerRunStatus,
} from "./trigger-browser-realtime";
import { createReasoningSequenceGuard } from "./agent-long-reasoning-sequence-guard";

/**
 * `fetch` adapter for Trigger-backed Agent mode used by the chat transport.
 *
 *   1. POST the request body to /api/agent, which triggers a durable
 *      trigger.dev task and returns { runId, publicAccessToken }.
 *   2. Subscribe to the task's "ui" metadata stream (Vercel AI SDK
 *      UIMessage chunks the task emitted).
 *   3. Re-encode each chunk as an SSE `data: ...\n\n` frame so the caller's
 *      `useChat` consumes it identically to a normal streaming response.
 *
 * On reconnect (page reload while a run is still executing), useChat fires
 * a GET against the configured reconnect URL; we route that through
 * `resumeAgentLongStream`, which fetches the active runId from
 * /api/agent/resume and pipes the same trigger.dev stream. Trigger.dev
 * streams are durable for 28 days, so a fresh subscription replays every
 * chunk from the beginning — useChat reconstructs the in-progress
 * assistant turn without needing a client-side cursor.
 */
type RunHandle = {
  runId: string;
  publicAccessToken: string;
  chatId?: string;
  approvalSessionId?: string;
  approvalSessionPublicAccessToken?: string;
};

type AgentLongRealtimeCancel = () => Promise<void> | void;

const activeAgentLongRealtimeCancels = new Map<
  string,
  Set<AgentLongRealtimeCancel>
>();

const registerAgentLongRealtimeCancel = (
  chatId: string | undefined,
  cancel: AgentLongRealtimeCancel,
): (() => void) | undefined => {
  if (!chatId) return undefined;

  let cancels = activeAgentLongRealtimeCancels.get(chatId);
  if (!cancels) {
    cancels = new Set();
    activeAgentLongRealtimeCancels.set(chatId, cancels);
  }
  cancels.add(cancel);

  return () => {
    const currentCancels = activeAgentLongRealtimeCancels.get(chatId);
    if (!currentCancels) return;
    currentCancels.delete(cancel);
    if (currentCancels.size === 0) {
      activeAgentLongRealtimeCancels.delete(chatId);
    }
  };
};

export const cancelAgentLongRealtimeStreams = (chatId?: string): void => {
  const cancels =
    chatId === undefined
      ? Array.from(activeAgentLongRealtimeCancels.values()).flatMap((set) =>
          Array.from(set),
        )
      : Array.from(activeAgentLongRealtimeCancels.get(chatId) ?? []);

  for (const cancel of cancels) {
    void Promise.resolve(cancel()).catch(() => undefined);
  }
};

const createLinkedAbortController = (
  signal: AbortSignal | undefined,
): { controller: AbortController; cleanup: () => void } => {
  const controller = new AbortController();
  const abort = () => controller.abort();

  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }

  return {
    controller,
    cleanup: () => signal?.removeEventListener("abort", abort),
  };
};

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
const POST_FINISH_DRAIN_TIMEOUT_MS = 2_000;
const COMPLETED_RUN_DRAIN_TIMEOUT_MS = 5_000;
const QUIET_STREAM_STATUS_POLL_INTERVAL_MS = 2_000;
const QUIET_STREAM_STATUS_POLL_AFTER_MS = 5_000;

const getChatIdFromRequestInit = (
  init: RequestInit | undefined,
): string | undefined => {
  if (typeof init?.body !== "string") return undefined;
  try {
    const body = JSON.parse(init.body) as { chatId?: unknown };
    return typeof body.chatId === "string" ? body.chatId : undefined;
  } catch {
    return undefined;
  }
};

const getChatIdFromResumeUrl = (url: string): string | undefined => {
  try {
    const base =
      typeof window === "undefined" ? "http://localhost" : window.location.href;
    return new URL(url, base).searchParams.get("chatId") ?? undefined;
  } catch {
    return undefined;
  }
};

const getStatusEndpointFromResumeUrl = (url: string): string => {
  try {
    const base =
      typeof window === "undefined" ? "http://localhost" : window.location.href;
    const pathname = new URL(url, base).pathname;
    return pathname === LEGACY_AGENT_RESUME_ENDPOINT
      ? LEGACY_AGENT_STATUS_ENDPOINT
      : AGENT_STATUS_ENDPOINT;
  } catch {
    return AGENT_STATUS_ENDPOINT;
  }
};

const buildSSEResponseFromRun = (
  handle: RunHandle,
  signal?: AbortSignal,
  options?: { chatId?: string; statusEndpoint?: string },
): Response => {
  const { runId, publicAccessToken } = handle;
  const encoder = new TextEncoder();
  const chatId = options?.chatId ?? handle.chatId;
  const statusEndpoint = options?.statusEndpoint ?? AGENT_STATUS_ENDPOINT;
  let cancelRealtimeSubscriptions: (() => Promise<void> | void) | undefined;
  let closeConsumerStream: (() => void) | undefined;
  let consumerCanceled = false;
  let unregisterRealtimeCancel: (() => void) | undefined;
  const cancelConsumerRealtime = async () => {
    consumerCanceled = true;
    closeConsumerStream?.();
    await cancelRealtimeSubscriptions?.();
    unregisterRealtimeCancel?.();
  };
  unregisterRealtimeCancel = registerAgentLongRealtimeCancel(
    chatId,
    cancelConsumerRealtime,
  );
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let readAbortController: AbortController | undefined;
      let statusMonitorInterval: ReturnType<typeof setInterval> | undefined;
      let statusPollInterval: ReturnType<typeof setInterval> | undefined;
      let streamIterator: AsyncIterator<unknown> | undefined;
      let userAborted = false;
      const isControllerErrored = () => controller.desiredSize === null;
      const enqueueAgentApprovalSessionPart = () => {
        if (
          !handle.approvalSessionId ||
          !handle.approvalSessionPublicAccessToken ||
          closed
        ) {
          return;
        }
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              type: "data-agent-approval-session",
              id: `agent-approval-session-${runId}`,
              transient: true,
              data: {
                chatId,
                sessionId: handle.approvalSessionId,
                publicAccessToken: handle.approvalSessionPublicAccessToken,
              },
            })}\n\n`,
          ),
        );
      };

      cancelRealtimeSubscriptions = async () => {
        readAbortController?.abort();
        if (statusMonitorInterval !== undefined) {
          clearInterval(statusMonitorInterval);
        }
        if (statusPollInterval !== undefined) {
          clearInterval(statusPollInterval);
        }
        await streamIterator?.return?.(undefined).catch(() => undefined);
      };

      // Always close with an abort rather than controller.error() so useChat
      // reliably exits streaming state even when subscription throws.
      const sendAbortAndClose = () => {
        if (closed) return;
        closed = true;
        if (!isControllerErrored()) {
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
        }
      };
      closeConsumerStream = sendAbortAndClose;

      const close = () => {
        if (closed) return;
        closed = true;
        if (!isControllerErrored()) {
          try {
            controller.close();
          } catch {
            // already closed by sendAbortAndClose
          }
        }
      };

      // Timeout guard: if the subscription hangs (e.g. task failed before
      // registering the stream), force-close after STREAM_TIMEOUT_MS.
      const timeoutId = setTimeout(() => {
        readAbortController?.abort();
        sendAbortAndClose();
      }, STREAM_TIMEOUT_MS);

      // Short-circuit if the consumer already aborted before we got here.
      if (signal?.aborted || consumerCanceled) {
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
        readAbortController = new AbortController();
        if (signal?.aborted || consumerCanceled) {
          userAborted = true;
          readAbortController.abort();
          return;
        }

        enqueueAgentApprovalSessionPart();

        const completedRunDrainTimeout = Symbol("completed-run-drain-timeout");
        let completedRunDrainTimer: ReturnType<typeof setTimeout> | undefined;
        let resolveCompletedRunDrain:
          ((value: typeof completedRunDrainTimeout) => void) | undefined;
        const completedRunDrainPromise = new Promise<
          typeof completedRunDrainTimeout
        >((resolve) => {
          resolveCompletedRunDrain = resolve;
        });

        let sawTerminalChunk = false;
        let sawFinishChunk = false;
        let timedOutAfterFinish = false;
        let completedRunDrainElapsed = false;
        let firstEventReceived = false;
        let lastEventReceivedAt = Date.now();
        let isPollingRunStatus = false;

        const clearCompletedRunDrainTimer = () => {
          if (completedRunDrainTimer === undefined) return;
          clearTimeout(completedRunDrainTimer);
          completedRunDrainTimer = undefined;
        };

        const startCompletedRunDrainTimer = () => {
          if (
            completedRunDrainTimer !== undefined ||
            sawTerminalChunk ||
            closed
          ) {
            return;
          }

          completedRunDrainTimer = setTimeout(() => {
            resolveCompletedRunDrain?.(completedRunDrainTimeout);
          }, COMPLETED_RUN_DRAIN_TIMEOUT_MS);
        };

        const enqueueSyntheticFinish = () => {
          if (closed || sawFinishChunk) return;
          try {
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "finish" })}\n\n`),
            );
          } catch {
            // controller may already be closed
          }
          sawFinishChunk = true;
        };

        const handleRunStatus = (status: string | undefined) => {
          if (status === "COMPLETED") {
            startCompletedRunDrainTimer();
            return;
          }
          if (status && TERMINAL_RUN_STATUSES.has(status)) {
            readAbortController?.abort();
          }
        };

        const pollRunStatusForTerminalRun = async () => {
          const status = await retrieveTriggerRunStatus(runId, {
            chatId,
            signal: readAbortController?.signal,
            statusEndpoint,
          });
          handleRunStatus(status);
        };

        const pollRunStatusWhenIdle = async (options?: {
          beforeFirstEvent?: boolean;
        }) => {
          if (
            sawTerminalChunk ||
            closed ||
            readAbortController?.signal.aborted ||
            isPollingRunStatus ||
            (options?.beforeFirstEvent === true && firstEventReceived) ||
            (options?.beforeFirstEvent !== true &&
              (!firstEventReceived ||
                Date.now() - lastEventReceivedAt <
                  QUIET_STREAM_STATUS_POLL_AFTER_MS))
          ) {
            return;
          }

          isPollingRunStatus = true;
          try {
            await pollRunStatusForTerminalRun();
          } catch {
            // The stream path remains authoritative; retry on the next poll.
          } finally {
            isPollingRunStatus = false;
          }
        };

        // Monitor run failure separately from the UI stream. Reading the
        // stream directly avoids a race where the mixed run+stream
        // subscription can discover the stream late and replay chunks only
        // at completion.
        statusMonitorInterval = setInterval(() => {
          void pollRunStatusWhenIdle({ beforeFirstEvent: true });
        }, QUIET_STREAM_STATUS_POLL_INTERVAL_MS);
        void pollRunStatusWhenIdle({ beforeFirstEvent: true });

        const uiStream = readTriggerRunStream<unknown>(
          runId,
          AGENT_UI_STREAM_ID,
          {
            accessToken: publicAccessToken,
            signal: readAbortController.signal,
            timeoutInSeconds: STREAM_IDLE_TIMEOUT_SECONDS,
          },
        );

        statusPollInterval = setInterval(() => {
          void pollRunStatusWhenIdle();
        }, QUIET_STREAM_STATUS_POLL_INTERVAL_MS);

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
        const reasoningSequenceGuard = createReasoningSequenceGuard();

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
        const postFinishDrainTimeout = Symbol("post-finish-drain-timeout");
        const abortPromise = new Promise<typeof abortSentinel>((resolve) => {
          if (!signal) return; // never resolves — Promise.race ignores it
          signal.addEventListener("abort", () => resolve(abortSentinel), {
            once: true,
          });
        });

        const iter = uiStream[Symbol.asyncIterator]();
        streamIterator = iter;
        const readNextChunk = () => {
          if (!sawFinishChunk) {
            return Promise.race([
              iter.next(),
              abortPromise,
              completedRunDrainPromise,
            ]);
          }

          let timeoutId: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<typeof postFinishDrainTimeout>(
            (resolve) => {
              timeoutId = setTimeout(
                () => resolve(postFinishDrainTimeout),
                POST_FINISH_DRAIN_TIMEOUT_MS,
              );
            },
          );

          return Promise.race([
            iter.next(),
            abortPromise,
            timeoutPromise,
            completedRunDrainPromise,
          ]).finally(() => {
            if (timeoutId !== undefined) {
              clearTimeout(timeoutId);
            }
          });
        };

        while (true) {
          const next = await readNextChunk();
          if (next === abortSentinel) {
            userAborted = true;
            break;
          }
          if (next === postFinishDrainTimeout) {
            timedOutAfterFinish = true;
            break;
          }
          if (next === completedRunDrainTimeout) {
            completedRunDrainElapsed = true;
            flushDeltaBuffers();
            enqueueSyntheticFinish();
            sawTerminalChunk = true;
            break;
          }
          if (next.done) break;
          const chunk = next.value;
          lastEventReceivedAt = Date.now();

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
            reasoningSequenceGuard.shouldDrop(
              chunk as { type?: string; id?: string },
            )
          ) {
            continue;
          }

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
          if (chunkType === "finish") {
            // The task writes a few data chunks after `finish`
            // (message-metadata, auto-continue).
            // Drain that short tail so the browser receives them.
            clearCompletedRunDrainTimer();
            sawTerminalChunk = true;
            sawFinishChunk = true;
            continue;
          }

          // abort / error are terminal and do not have useful trailing data.
          if (chunkType === "abort" || chunkType === "error") {
            clearCompletedRunDrainTimer();
            sawTerminalChunk = true;
            break;
          }
        }

        // Flush any deltas that didn't trigger a count- or timer-based flush.
        flushDeltaBuffers();

        if (userAborted || timedOutAfterFinish || completedRunDrainElapsed) {
          // Release the trigger.dev subscription so it doesn't keep
          // streaming chunks into a dead controller.
          await cancelRealtimeSubscriptions?.();
        }

        if (!sawTerminalChunk) {
          // Subscription ended without a terminal UI chunk — run crashed,
          // was canceled, or failed before registering the stream.
          sendAbortAndClose();
        }

        clearCompletedRunDrainTimer();
        if (statusPollInterval !== undefined) {
          clearInterval(statusPollInterval);
        }
        if (statusMonitorInterval !== undefined) {
          clearInterval(statusMonitorInterval);
        }

        // Normal close path (sawTerminalChunk = true exits loop above).
        clearTimeout(timeoutId);
        close();
      } catch {
        clearTimeout(timeoutId);
        // Always send an abort on error so useChat cleans up.
        if (!consumerCanceled) {
          sendAbortAndClose();
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (statusMonitorInterval !== undefined) {
          clearInterval(statusMonitorInterval);
        }
        if (statusPollInterval !== undefined) {
          clearInterval(statusPollInterval);
        }
        cancelRealtimeSubscriptions = undefined;
        closeConsumerStream = undefined;
        unregisterRealtimeCancel?.();
      }
    },
    cancel() {
      return cancelConsumerRealtime().finally(() => {
        unregisterRealtimeCancel?.();
      });
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders });
};

export const fetchAgentLongStream = async (
  init: RequestInit | undefined,
): Promise<Response> => {
  const chatId = getChatIdFromRequestInit(init);
  const linkedAbort = createLinkedAbortController(init?.signal ?? undefined);
  const unregisterStartCancel = registerAgentLongRealtimeCancel(chatId, () => {
    linkedAbort.controller.abort();
  });

  try {
    const startResponse = await fetchWithErrorHandlers(AGENT_API_ENDPOINT, {
      ...init,
      signal: linkedAbort.controller.signal,
    });
    if (!startResponse.ok) return startResponse;

    const handle: RunHandle = await startResponse.json();
    return buildSSEResponseFromRun(handle, init?.signal ?? undefined, {
      chatId,
      statusEndpoint: AGENT_STATUS_ENDPOINT,
    });
  } finally {
    unregisterStartCancel?.();
    linkedAbort.cleanup();
  }
};

export const resumeAgentLongStream = async (
  url: string,
  init: RequestInit | undefined,
): Promise<Response> => {
  const chatId = getChatIdFromResumeUrl(url);
  const linkedAbort = createLinkedAbortController(init?.signal ?? undefined);
  const unregisterStartCancel = registerAgentLongRealtimeCancel(chatId, () => {
    linkedAbort.controller.abort();
  });

  // useChat's reconnectToStream signals "nothing to resume" by treating a
  // 204 as null. /api/agent/resume returns 204 when the chat has no
  // active run (or the stored run hit a terminal state); pass that through.
  try {
    const response = await fetchWithErrorHandlers(url, {
      ...init,
      method: "GET",
      signal: linkedAbort.controller.signal,
    });
    if (response.status === 204) return response;
    if (!response.ok) return response;

    const handle: RunHandle = await response.json();
    return buildSSEResponseFromRun(handle, init?.signal ?? undefined, {
      chatId,
      statusEndpoint: getStatusEndpointFromResumeUrl(url),
    });
  } finally {
    unregisterStartCancel?.();
    linkedAbort.cleanup();
  }
};
