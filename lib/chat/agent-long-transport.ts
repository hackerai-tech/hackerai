import { fetchWithErrorHandlers } from "@/lib/utils";
import { AGENT_UI_STREAM_ID } from "@/trigger/stream-ids";

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

const TERMINAL_RUN_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "CRASHED",
  "CANCELED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

// Maximum time to wait for the first stream event. If the task fails before
// registering the "ui" stream, withStreams() can hang indefinitely waiting
// for a stream that never comes. This timeout guarantees the SSE connection
// always closes and useChat exits streaming state.
const STREAM_TIMEOUT_MS = 30_000;

const buildSSEResponseFromRun = ({
  runId,
  publicAccessToken,
}: RunHandle): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Always close with an abort rather than controller.error() so useChat
      // reliably exits streaming state even when subscription throws.
      const sendAbortAndClose = () => {
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

      // Timeout guard: if the subscription hangs (e.g. task failed before
      // registering the stream), force-close after STREAM_TIMEOUT_MS.
      const timeoutId = setTimeout(sendAbortAndClose, STREAM_TIMEOUT_MS);

      try {
        const { runs, auth } = await import("@trigger.dev/sdk");

        await auth.withAuth({ accessToken: publicAccessToken }, async () => {
          const subscription = runs
            .subscribeToRun(runId)
            .withStreams<{ ui: unknown }>();

          let sawTerminalChunk = false;
          for await (const part of subscription) {
            // Detect terminal run status (FAILED, CRASHED, etc.) and
            // immediately synthesize an abort so useChat exits streaming
            // state without waiting for the subscription to fully close.
            if (
              typeof part === "object" &&
              part !== null &&
              "status" in part &&
              typeof (part as { status?: unknown }).status === "string" &&
              TERMINAL_RUN_STATUSES.has((part as { status: string }).status)
            ) {
              break; // fall through to !sawTerminalChunk → sendAbortAndClose
            }

            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              (part as { type: string }).type === AGENT_UI_STREAM_ID
            ) {
              const chunk = (part as { chunk?: unknown }).chunk;
              if (chunk === undefined) continue;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
              );
              // finish / abort / error are the last chunks useChat needs.
              const chunkType = (chunk as { type?: string }).type;
              if (
                chunkType === "finish" ||
                chunkType === "abort" ||
                chunkType === "error"
              ) {
                sawTerminalChunk = true;
                break;
              }
            }
          }

          if (!sawTerminalChunk) {
            // Subscription ended without a terminal UI chunk — run crashed,
            // was canceled, or failed before registering the stream.
            sendAbortAndClose();
          }
        });

        // Normal close path (sawTerminalChunk = true exits loop above).
        clearTimeout(timeoutId);
        try {
          controller.close();
        } catch {
          // already closed by sendAbortAndClose
        }
      } catch {
        clearTimeout(timeoutId);
        // Always send an abort on error so useChat cleans up.
        sendAbortAndClose();
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
  return buildSSEResponseFromRun(handle);
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
  return buildSSEResponseFromRun(handle);
};
