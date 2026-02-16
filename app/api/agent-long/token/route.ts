import { auth } from "@trigger.dev/sdk/v3";
import { getChatById } from "@/lib/db/actions";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import type { NextRequest } from "next/server";

/**
 * GET /api/agent-long/token?runId=...&chatId=...
 * Verifies the user owns the chat and the run is the active run for that chat,
 * then returns a Trigger.dev public access token for that run so the client can reconnect after reload.
 * Only accepts when active_trigger_run_id === runId; rejects when there is no active run (null).
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get("runId");
    const chatId = searchParams.get("chatId");

    if (!runId || !chatId) {
      return Response.json(
        { message: "Missing runId or chatId" },
        { status: 400 },
      );
    }

    const userId = await getUserID(req);
    const chat = await getChatById({ id: chatId });

    if (!chat || chat.user_id !== userId) {
      return Response.json(
        { message: "Chat not found or access denied" },
        { status: 404 },
      );
    }

    if (chat.active_trigger_run_id == null) {
      return Response.json(
        { message: "No active run for this chat" },
        { status: 403 },
      );
    }
    if (chat.active_trigger_run_id !== runId) {
      return Response.json(
        { message: "Run does not belong to this chat" },
        { status: 403 },
      );
    }

    const publicAccessToken = await auth.createPublicToken({
      scopes: { read: { runs: [runId] } },
      expirationTime: "1hr",
    });

    return Response.json({ publicAccessToken });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    throw error;
  }
}
