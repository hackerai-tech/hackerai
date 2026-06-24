import { NextRequest, NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk";

import { getUserID } from "@/lib/auth/get-user-id";
import {
  deleteAllChatsForBackend,
  getActiveTriggerRunsForUser,
} from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";
import { assertUserCanAccessChatHistory } from "@/lib/suspensions";

export const maxDuration = 30;

const TRIGGER_CANCEL_CONCURRENCY = 4;

async function cancelTriggerRuns(triggerRunIds: string[]) {
  for (let i = 0; i < triggerRunIds.length; i += TRIGGER_CANCEL_CONCURRENCY) {
    const chunk = triggerRunIds.slice(i, i + TRIGGER_CANCEL_CONCURRENCY);
    await Promise.all(chunk.map((triggerRunId) => runs.cancel(triggerRunId)));
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const userId = await getUserID(req);
    await assertUserCanAccessChatHistory(userId);
    const activeTriggerRuns = await getActiveTriggerRunsForUser({ userId });

    if (activeTriggerRuns.hasMore) {
      return new NextResponse("Too many active chat runs to delete safely", {
        status: 409,
      });
    }

    const triggerRunIds = [
      ...new Set(activeTriggerRuns.runs.map((run) => run.triggerRunId)),
    ];

    await cancelTriggerRuns(triggerRunIds);
    await deleteAllChatsForBackend({ userId });

    return NextResponse.json({
      deleted: true,
      canceledTriggerRuns: triggerRunIds.length,
    });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    console.error("[DELETE /api/chats] failed:", error);
    return new NextResponse("Failed to delete all chats", { status: 500 });
  }
}
