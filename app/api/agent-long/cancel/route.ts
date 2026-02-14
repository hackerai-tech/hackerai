import { runs } from "@trigger.dev/sdk/v3";
import { getChatById } from "@/lib/db/actions";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";
import type { NextRequest } from "next/server";

/**
 * POST /api/agent-long/cancel
 * Verifies the user owns the chat, then cancels the run server-side (where TRIGGER_SECRET_KEY is available).
 * Accepts cancel when active_trigger_run_id matches runId OR when it is already cleared (client may clear
 * it before this request completes for responsive UX), so we only require chat ownership.
 */
export async function POST(req: NextRequest) {
  try {
    let body: { runId?: string; chatId?: string };
    try {
      body = await req.json();
    } catch {
      return Response.json({ message: "Invalid JSON body" }, { status: 400 });
    }

    const { runId, chatId } = body;
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

    // Allow cancel when run is still the active run, or when active run was already cleared
    // (client clears it immediately for UX; we only require chat ownership).
    const runStillActive = chat.active_trigger_run_id === runId;
    const runAlreadyCleared = chat.active_trigger_run_id == null;
    if (!runStillActive && !runAlreadyCleared) {
      return Response.json(
        { message: "Run does not belong to this chat" },
        { status: 403 },
      );
    }

    if (!process.env.TRIGGER_SECRET_KEY) {
      return Response.json(
        {
          message: "Trigger.dev is not configured (missing TRIGGER_SECRET_KEY)",
        },
        { status: 503 },
      );
    }

    await runs.cancel(runId);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    throw error;
  }
}
