import { createUIMessageStreamResponse } from "ai";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { getChatById } from "@/lib/db/actions";
import { createRedisChunkReadable } from "@/lib/utils/redis-stream";
import type { NextRequest } from "next/server";

export const maxDuration = 800;

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

  // Verify chat ownership
  try {
    const chat = await getChatById({ id: chatId });
    if (!chat || chat.user_id !== userId) {
      return new Response("Not found", { status: 404 });
    }
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const startIndex = searchParams.get("startIndex") ?? "0-0";

  const stream = createRedisChunkReadable(chatId, startIndex);

  return createUIMessageStreamResponse({ stream });
}
