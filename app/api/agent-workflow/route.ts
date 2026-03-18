import { start } from "workflow/api";
import { createUIMessageStreamResponse } from "ai";
import { agentWorkflow } from "@/workflows/agent-workflow";
import { prepareAgentPayload } from "@/lib/api/prepare-agent-payload";
import { ChatSDKError } from "@/lib/errors";
import { createChatLogger } from "@/lib/api/chat-logger";
import { getUserFriendlyProviderError } from "@/lib/utils/error-utils";
import { startStream } from "@/lib/db/actions";
import {
  createRedisChunkReadable,
  resetStream,
} from "@/lib/utils/redis-stream";
import type { NextRequest } from "next/server";

export const maxDuration = 800;

export async function POST(req: NextRequest) {
  let chatId: string | undefined;

  try {
    const payload = await prepareAgentPayload(req, "agent");
    chatId = payload.chatId;

    const run = await start(agentWorkflow, [payload]);

    // Reset the Redis stream so stale chunks from a previous run
    // (e.g. after regenerate) are not replayed to the new reader.
    await resetStream(payload.chatId);
    await startStream({
      chatId: payload.chatId,
      streamId: `rstream_${payload.chatId}`,
    });

    const stream = createRedisChunkReadable(payload.chatId);

    return createUIMessageStreamResponse({
      stream,
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

    console.error("Unexpected error in agent-workflow route:", error);
    const unexpectedError = new ChatSDKError(
      "bad_request:stream",
      getUserFriendlyProviderError(error),
    );
    return unexpectedError.toResponse();
  }
}
