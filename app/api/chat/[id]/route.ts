import { NextRequest, NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk";

import { getUserID } from "@/lib/auth/get-user-id";
import { deleteChatForBackend, getChatById } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";

export const maxDuration = 30;

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: chatId } = await params;
    if (!chatId) {
      return new NextResponse("chatId required", { status: 400 });
    }

    const userId = await getUserID(req);
    const chat = await getChatById({ id: chatId });

    if (!chat) {
      return NextResponse.json({ deleted: true, reason: "not_found" });
    }

    if (chat.user_id !== userId) {
      return new NextResponse("Forbidden", { status: 403 });
    }

    const triggerRunId = chat.active_trigger_run_id;
    let canceledTriggerRun = false;

    if (triggerRunId) {
      await runs.cancel(triggerRunId);
      canceledTriggerRun = true;
    }

    await deleteChatForBackend({ chatId, userId });

    return NextResponse.json({
      deleted: true,
      canceledTriggerRun,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    console.error("[DELETE /api/chat/[id]] failed:", error);
    return new NextResponse("Failed to delete chat", { status: 500 });
  }
}
