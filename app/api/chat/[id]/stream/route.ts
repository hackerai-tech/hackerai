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
import { phLogger } from "@/lib/posthog/server";

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

  // Best-effort cleanup of a stale `active_stream_id`. Called whenever we
  // detect the producer is dead so subsequent reconnects skip straight to
  // replay instead of hitting the ack-timeout (~5s) again.
  const clearStaleActiveStream = async () => {
    try {
      await convex.mutation(api.chatStreams.prepareForNewStream, {
        serviceKey,
        chatId,
      });
    } catch {
      // Best-effort — the next reconnect will re-attempt cleanup.
    }
  };

  if (recentStreamId) {
    let stream: ReadableStream | null = null;
    let resumableThrew = false;
    try {
      stream = await streamContext.resumableStream(recentStreamId, () =>
        emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
      );
    } catch {
      // Producer is gone (ack timeout) — fall through to replay fallback
      resumableThrew = true;
    }

    if (resumableThrew) {
      await clearStaleActiveStream();
    }

    if (stream) {
      const reader = stream.getReader();

      // Peek the first chunk. When `active_stream_id` is still set in DB but
      // the resumable buffer is empty (producer finished and the buffer
      // expired), `resumableStream` invokes the no-op fallback, which emits
      // only the SSE `[DONE]` terminator. Returning that to the client renders
      // an empty assistant message — fall through to the replay branch instead.
      const first = await reader.read();
      const firstText = first.done
        ? ""
        : typeof first.value === "string"
          ? first.value
          : new TextDecoder().decode(first.value as Uint8Array);
      const isNoopStream =
        first.done || /^\s*data:\s*\[DONE\]\s*$/m.test(firstText.trim());

      if (isNoopStream) {
        reader.releaseLock();
        try {
          await stream.cancel();
        } catch {
          // ignore — falling through to replay
        }
        await clearStaleActiveStream();
      } else {
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

        let pendingFirstDelivered = false;

        const abortableStream = new ReadableStream({
          async pull(controller) {
            try {
              if (!pendingFirstDelivered) {
                pendingFirstDelivered = true;
                controller.enqueue(first.value);
                return;
              }

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
                phLogger.info("Stream route preemptive abort caught", {
                  userId,
                  chatId,
                  timeSinceTriggerMs: triggerTime
                    ? cleanupStart - triggerTime
                    : null,
                });
              }

              preemptiveTimeout.clear();

              if (
                error instanceof DOMException &&
                error.name === "AbortError"
              ) {
                if (isPreemptive) {
                  phLogger.info("Stream route closing controller after abort", {
                    userId,
                    chatId,
                    cleanupDurationMs: Date.now() - cleanupStart,
                  });
                  await phLogger.flush();
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
              phLogger.info("Stream route cancel called", { userId, chatId });
            }
            preemptiveTimeout.clear();
            reader.cancel();
            cancellationSubscriber.stop();
            if (isPreemptive) {
              phLogger.flush();
            }
          },
        });

        return new Response(abortableStream, { status: 200 });
      }
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
      // Producer is dead and there's nothing to replay — clear the stale
      // active_stream_id so the chat isn't stuck in a "resuming" state on
      // every page load.
      if (recentStreamId) {
        await clearStaleActiveStream();
      }
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
  } catch {
    return new Response(
      emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
      { status: 200 },
    );
  }
}
