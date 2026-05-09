import { fetchWithErrorHandlers } from "@/lib/utils";

/**
 * `fetch` adapter for "agent-long" mode used by the chat transport.
 *
 *   1. POST the request body to /api/agent-long, which triggers a durable
 *      trigger.dev task and returns { runId, publicAccessToken }.
 *   2. Subscribe to the task's "ui" metadata stream (Vercel AI SDK
 *      UIMessage chunks the task emitted).
 *   3. Re-encode each chunk as an SSE `data: ...\n\n` frame so the caller's
 *      `useChat` consumes it identically to a normal streaming response.
 */
type RunHandle = { runId: string; publicAccessToken: string };

export const fetchAgentLongStream = async (
  init: RequestInit | undefined,
): Promise<Response> => {
  const startResponse = await fetchWithErrorHandlers("/api/agent-long", init);
  if (!startResponse.ok) return startResponse;

  const { runId, publicAccessToken }: RunHandle = await startResponse.json();

  // Lazy import keeps the SDK out of the initial bundle for users who
  // never select long mode.
  const { runs, auth } = await import("@trigger.dev/sdk");

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // Scope the public token to this single subscription call rather
        // than mutating the global SDK config (which would race across
        // tabs / users).
        await auth.withAuth({ accessToken: publicAccessToken }, async () => {
          const subscription = runs
            .subscribeToRun(runId)
            .withStreams<{ ui: unknown }>();

          let sawTerminalChunk = false;
          for await (const part of subscription) {
            if (
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              (part as { type: string }).type === "ui"
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

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};
