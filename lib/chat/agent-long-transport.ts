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

const buildSSEResponseFromRun = ({
  runId,
  publicAccessToken,
}: RunHandle): Response => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Lazy import keeps the SDK out of the initial bundle for users who
        // never select long mode.
        const { runs, auth } = await import("@trigger.dev/sdk");

        // Scope the public token to this single subscription call rather
        // than mutating the global SDK config (which would race across
        // tabs / users).
        await auth.withAuth({ accessToken: publicAccessToken }, async () => {
          const subscription = runs
            .subscribeToRun(runId)
            .withStreams<{ ui: unknown }>();

          const TERMINAL_RUN_STATUSES = new Set([
            "COMPLETED",
            "FAILED",
            "CRASHED",
            "CANCELED",
            "SYSTEM_FAILURE",
            "TIMED_OUT",
            "EXPIRED",
          ]);

          let sawTerminalChunk = false;
          for await (const part of subscription) {
            // Detect terminal run status (FAILED, CRASHED, etc.) and
            // immediately synthesize an abort so useChat exits the
            // streaming state without waiting for the subscription to close.
            if (
              typeof part === "object" &&
              part !== null &&
              "status" in part &&
              typeof (part as { status?: unknown }).status === "string" &&
              TERMINAL_RUN_STATUSES.has((part as { status: string }).status)
            ) {
              if (!sawTerminalChunk) {
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "abort" })}\n\n`,
                  ),
                );
                sawTerminalChunk = true;
              }
              break;
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
              // The AI SDK UI message stream emits `finish` (and `abort` /
              // `error` on early exit) as the very last chunk. Once we've
              // forwarded it, useChat has everything it needs — close the
              // SSE response immediately instead of waiting for trigger.dev
              // to round-trip the run's COMPLETED status, which is what
              // would otherwise leave the UI stuck in the streaming state.
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
            // Subscription ended without a terminal chunk (run crashed,
            // was canceled, or the stream was truncated). Synthesize an
            // abort so useChat exits the streaming state cleanly.
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: "abort" })}\n\n`),
            );
          }
        });
        controller.close();
      } catch (error) {
        controller.error(error);
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
