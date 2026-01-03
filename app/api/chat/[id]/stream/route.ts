import type { NextRequest } from "next/server";
import { createUIMessageStream, JsonToSseTransformStream } from "ai";
import { ChatSDKError } from "@/lib/errors";
import type { ChatMessage } from "@/types/chat";
import { getStreamContext } from "@/lib/api/chat-handler";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

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

  const emptyDataStream = createUIMessageStream<ChatMessage>({
    execute: () => {},
  });

  if (recentStreamId) {
    const stream = await streamContext.resumableStream(recentStreamId, () =>
      emptyDataStream.pipeThrough(new JsonToSseTransformStream()),
    );

    if (stream) {
      return new Response(stream, { status: 200 });
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
