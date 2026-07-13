import { NextRequest, NextResponse } from "next/server";

import { getUserID } from "@/lib/auth/get-user-id";
import { deleteChatForBackend, getChatById } from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { assertUserCanAccessChatHistory } from "@/lib/suspensions";
import {
  cancelAgentTriggerRun,
  closeAgentApprovalSession,
} from "@/lib/api/agent-approval-session";

export const maxDuration = 30;
const MAX_DELETE_SNAPSHOT_ATTEMPTS = 3;

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
    await assertUserCanAccessChatHistory(userId);
    let canceledTriggerRun = false;
    let closedApprovalSession = false;

    for (let attempt = 0; attempt < MAX_DELETE_SNAPSHOT_ATTEMPTS; attempt++) {
      const chat = await getChatById({ id: chatId });
      if (!chat) {
        return NextResponse.json({
          deleted: true,
          ...(attempt === 0 ? { reason: "not_found" } : {}),
          ...(attempt > 0 ? { canceledTriggerRun, closedApprovalSession } : {}),
        });
      }

      if (chat.user_id !== userId) {
        return new NextResponse("Forbidden", { status: 403 });
      }

      const triggerRunId = chat.active_trigger_run_id;
      const approvalSessionId = chat.active_agent_approval_session_id;
      const [closed, canceled] = await Promise.all([
        closeAgentApprovalSession(approvalSessionId, "chat-deleted"),
        cancelAgentTriggerRun(triggerRunId),
      ]);
      closedApprovalSession ||= closed;
      canceledTriggerRun ||= canceled;

      const deleteResult = await deleteChatForBackend({
        chatId,
        userId,
        expectedTriggerRunId: triggerRunId ?? null,
        expectedApprovalSessionId: approvalSessionId ?? null,
      });
      if (deleteResult !== "stale") {
        return NextResponse.json({
          deleted: true,
          canceledTriggerRun,
          closedApprovalSession,
        });
      }
    }

    return new NextResponse("Chat activity changed during deletion", {
      status: 409,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    console.error("[DELETE /api/chat/[id]] failed:", error);
    return new NextResponse("Failed to delete chat", { status: 500 });
  }
}
