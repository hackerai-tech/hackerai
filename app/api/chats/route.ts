import { NextRequest, NextResponse } from "next/server";

import { getUserID } from "@/lib/auth/get-user-id";
import {
  deleteAllChatsForBackend,
  fenceAndGetActiveAgentResourcesForUser,
} from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { assertUserCanAccessChatHistory } from "@/lib/suspensions";
import { closeAndCancelAgentResources } from "@/lib/api/agent-deletion-cleanup";
import { cancelSubagentsForUserDeletion } from "@/lib/db/subagents";

export const maxDuration = 30;

export async function DELETE(req: NextRequest) {
  try {
    const userId = await getUserID(req);
    await assertUserCanAccessChatHistory(userId);
    const activeAgentResources = await fenceAndGetActiveAgentResourcesForUser({
      userId,
    });

    if (activeAgentResources.hasMore) {
      return new NextResponse(
        "Too many active agent resources to delete safely",
        { status: 409 },
      );
    }

    const childCancellation = await cancelSubagentsForUserDeletion(
      userId,
      "all_chats_deleted",
    );
    if (childCancellation.hasMore) {
      return new NextResponse("Too many validation runs to delete safely", {
        status: 409,
      });
    }
    const cleanup = await closeAndCancelAgentResources(
      [
        ...activeAgentResources.resources,
        ...childCancellation.triggerRunIds.map((triggerRunId) => ({
          chatId: "subagent",
          triggerRunId,
        })),
      ],
      "chat-deleted",
    );
    await deleteAllChatsForBackend({ userId });

    return NextResponse.json({
      deleted: true,
      ...cleanup,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    console.error("[DELETE /api/chats] failed:", error);
    return new NextResponse("Failed to delete all chats", { status: 500 });
  }
}
