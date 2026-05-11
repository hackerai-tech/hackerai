import { NextRequest, NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk";

import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import {
  getChatById,
  getActiveTriggerRun,
  setActiveTriggerRun,
} from "@/lib/db/actions";
import { ChatSDKError } from "@/lib/errors";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  try {
    const { chatId }: { chatId: string } = await req.json();
    if (!chatId) {
      return new NextResponse("chatId required", { status: 400 });
    }

    const { userId } = await getUserIDAndPro(req);

    const chat = await getChatById({ id: chatId });
    if (!chat || chat.user_id !== userId) {
      return new NextResponse("Forbidden", { status: 403 });
    }

    const runId = await getActiveTriggerRun({ chatId });
    if (!runId) {
      // No active run — treat as already-stopped (idempotent).
      return NextResponse.json({ canceled: false, reason: "no_active_run" });
    }

    await runs.cancel(runId);
    await setActiveTriggerRun({ chatId, triggerRunId: null });

    return NextResponse.json({ canceled: true, runId });
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    console.error("[/api/agent-long/cancel] failed:", error);
    return new NextResponse("Failed to cancel run", { status: 500 });
  }
}
