import { start } from "workflow/api";
import { createUIMessageStreamResponse } from "ai";
import { agentWorkflow } from "@/workflows/agent-workflow";
import { prepareAgentPayload } from "@/lib/api/prepare-agent-payload";
import { ChatSDKError } from "@/lib/errors";
import { createChatLogger } from "@/lib/api/chat-logger";
import { getUserFriendlyProviderError } from "@/lib/utils/error-utils";
import { startStream } from "@/lib/db/actions";
import type { NextRequest } from "next/server";

// Only needs to cover the start() call and pre-processing, not the full agent execution.
// The actual agent runs inside the Workflow step (up to 1 hour).
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let chatId: string | undefined;

  try {
    const payload = await prepareAgentPayload(req, "agent");
    chatId = payload.chatId;

    const run = await start(agentWorkflow, [payload]);

    // Persist workflow run ID (wrun_*) as active_stream_id so the client's
    // WorkflowChatTransport can reconnect via /api/agent-workflow/[id]/stream.
    await startStream({ chatId: payload.chatId, streamId: run.runId });

    return createUIMessageStreamResponse({
      stream: run.readable,
      headers: { "x-workflow-run-id": run.runId },
    });
  } catch (error) {
    if (error instanceof ChatSDKError) {
      if (chatId) {
        const chatLogger = createChatLogger({
          chatId,
          endpoint: "/api/agent-workflow",
        });
        chatLogger.emitChatError(error);
      }
      return error.toResponse();
    }

    // Convert unexpected errors to user-friendly ChatSDKError
    console.error("Unexpected error in agent-workflow route:", error);
    const unexpectedError = new ChatSDKError(
      "bad_request:stream",
      getUserFriendlyProviderError(error),
    );
    return unexpectedError.toResponse();
  }
}
