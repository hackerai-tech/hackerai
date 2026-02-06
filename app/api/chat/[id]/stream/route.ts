import type { NextRequest } from "next/server";
import { createUIMessageStream, JsonToSseTransformStream } from "ai";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/types/chat";
import { getStreamContext } from "@/lib/api/chat-handler";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import {
  createCancellationSubscriber,
  createPreemptiveTimeout,
} from "@/lib/utils/stream-cancellation";
import { nextJsAxiomLogger } from "@/lib/axiom/server";

export const maxDuration = 800;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: chatId } = await params;

  const streamContext = getStreamContext();

  if (!streamContext) {
    return new Response(null, { status: 204 });
  }

  if (!chatId) {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  // Authenticate user
  let userId: string;
  try {
    const { getUserID } = await import("@/lib/auth/get-user-id");
    userId = await getUserID(req);
  } catch (error) {
    return new ChatSDKError("unauthorized:chat").toResponse();
  }

  const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;

  // Load chat and enforce ownership
  let chat: any | null = null;
  try {
    chat = await convex.query(api.chats.getChatById, {
      serviceKey,
      id: chatId,
    });
  } catch {
    return new ChatSDKError("not_found:chat").toResponse();
  }

  if (!chat) {
    return new ChatSDKError("not_found:chat").toResponse();
  }

  if (chat.user_id !== userId) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }

  const recentStreamId: string | undefined = chat.active_stream_id;
  const isTemporary = chat.temporary === true;

  const emptyDataStream = createUIMessageStream<ChatMessage>({
    execute: () => {},
  });

  if (recentStreamId) {
    const stream = await streamContext.resumableStream(recentStreamId, () =>
      emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
    );

    if (stream) {
      const abortController = new AbortController();

      // Set up pre-emptive timeout before Vercel's hard 800s limit
      const preemptiveTimeout = createPreemptiveTimeout({
        chatId,
        endpoint: "/api/chat/[id]/stream",
        abortController,
      });

      // Abort on client disconnect (tab close, network error, etc.)
      req.signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });

      // Abort on explicit stop button click (via Redis pub/sub or polling)
      const cancellationSubscriber = await createCancellationSubscriber({
        chatId,
        isTemporary,
        abortController,
        onStop: () => {},
      });

      const reader = stream.getReader();

      const abortableStream = new ReadableStream({
        async pull(controller) {
          try {
            // Create a promise that rejects on abort
            const abortPromise = new Promise<never>((_, reject) => {
              if (abortController.signal.aborted) {
                reject(new DOMException("Aborted", "AbortError"));
                return;
              }
              abortController.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
            });

            // Race between read and abort
            const { done, value } = await Promise.race([
              reader.read(),
              abortPromise,
            ]);

            if (done) {
              preemptiveTimeout.clear();
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch (error) {
            const isPreemptive = preemptiveTimeout.isPreemptive();
            const triggerTime = preemptiveTimeout.getTriggerTime();
            const cleanupStart = Date.now();

            if (isPreemptive) {
              nextJsAxiomLogger.info("Stream route preemptive abort caught", {
                chatId,
                timeSinceTriggerMs: triggerTime
                  ? cleanupStart - triggerTime
                  : null,
              });
            }

            preemptiveTimeout.clear();

            if (error instanceof DOMException && error.name === "AbortError") {
              if (isPreemptive) {
                nextJsAxiomLogger.info(
                  "Stream route closing controller after abort",
                  {
                    chatId,
                    cleanupDurationMs: Date.now() - cleanupStart,
                  },
                );
                await nextJsAxiomLogger.flush();
              }
              controller.close();
            } else {
              controller.error(error);
            }
          }
        },
        cancel() {
          const isPreemptive = preemptiveTimeout.isPreemptive();
          if (isPreemptive) {
            nextJsAxiomLogger.info("Stream route cancel called", { chatId });
          }
          preemptiveTimeout.clear();
          reader.cancel();
          cancellationSubscriber.stop();
          if (isPreemptive) {
            nextJsAxiomLogger.flush();
          }
        },
      });

      return new Response(abortableStream, { status: 200 });
    }
  }

  // Fallback: if no resumable stream, attempt to replay the most recent assistant message
  try {
    const mostRecentMessage = await convex.query(
      api.messages.getLastAssistantMessage,
      {
        serviceKey,
        chatId,
        userId,
      },
    );

    if (!mostRecentMessage) {
      return new Response(
        emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
        { status: 200 },
      );
    }

    const restoredStream = createUIMessageStream<ChatMessage>({
      execute: ({ writer }) => {
        writer.write({
          type: "data-appendMessage",
          data: JSON.stringify(mostRecentMessage),
          transient: true,
        });
      },
    });

    return new Response(
      restoredStream.pipeThrough(new JsonToSseTransformStream()),
      { status: 200 },
    );
  } catch (error) {
    return new Response(
      emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
      { status: 200 },
    );
  }
}
