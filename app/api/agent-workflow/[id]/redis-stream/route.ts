import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  JsonToSseTransformStream,
} from "ai";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById, prepareForNewStream } from "@/lib/db/actions";
import {
  createRedisChunkReadable,
  streamKeyExists,
  getStreamLength,
  resolveStartId,
} from "@/lib/utils/redis-stream";
import type { NextRequest } from "next/server";

export const maxDuration = 800;

/**
 * Returns a 200 response with an empty stream containing a "finish" event.
 * WorkflowChatTransport requires a "finish" chunk to stop reconnecting —
 * a 204 or error would be retried.
 */
function emptyFinishResponse() {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "finish", finishReason: "stop" });
    },
  });
  return new Response(stream.pipeThrough(new JsonToSseTransformStream()), {
    status: 200,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: chatId } = await params;

  const { userId } = await getUserIDAndPro(req);
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!chatId) {
    return new Response("Missing chat ID", { status: 400 });
  }

  // Verify chat ownership and check if stream is still active
  let chat: any;
  try {
    chat = await getChatById({ id: chatId });
    if (!chat || chat.user_id !== userId) {
      return new Response("Not found", { status: 404 });
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }

  // If active_stream_id is cleared, the workflow completed and updateChat
  // already ran. Return a finish response so the transport stops reconnecting
  // instead of replaying all chunks from Redis.
  if (!chat.active_stream_id) {
    return emptyFinishResponse();
  }

  // If active_stream_id is set but the Redis stream key no longer exists
  // (TTL expired, or was never created), the workflow is stale. Clear the
  // stale active_stream_id so the sidebar stops showing a loading indicator,
  // then return a finish response to unblock the client.
  if (!(await streamKeyExists(chatId))) {
    void prepareForNewStream({ chatId }).catch(() => {});
    return emptyFinishResponse();
  }

  const { searchParams } = new URL(req.url);
  const rawStartIndex = searchParams.get("startIndex") ?? "0-0";

  // WorkflowChatTransport sends a sequential chunk counter (e.g. "6225")
  // but Redis XREAD expects stream IDs (e.g. "1773935459492-0").
  // Resolve the counter to the correct Redis stream ID.
  const resolvedId = await resolveStartId(chatId, rawStartIndex);

  const streamLength = await getStreamLength(chatId);
  console.log(
    `[redis-stream] GET chatId=${chatId} startIndex=${rawStartIndex} resolvedId=${resolvedId} streamLength=${streamLength}`,
  );

  const stream = createRedisChunkReadable(chatId, resolvedId);

  return createUIMessageStreamResponse({ stream });
}
