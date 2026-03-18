import { start } from "workflow/api";
import { createUIMessageStreamResponse } from "ai";
import { agentWorkflow } from "@/workflows/agent-workflow";
import { prepareAgentPayload } from "@/lib/api/prepare-agent-payload";
import { ChatSDKError } from "@/lib/errors";
import { createChatLogger } from "@/lib/api/chat-logger";
import { getUserFriendlyProviderError } from "@/lib/utils/error-utils";
import { startStream } from "@/lib/db/actions";
import { isRedisStreamingEnabled } from "@/lib/auth/feature-flags";
import {
  createRedisChunkReadable,
  resetStream,
} from "@/lib/utils/redis-stream";
import type { NextRequest } from "next/server";

// This route streams workflow output via run.readable for its entire lifetime.
// Set to 800s (Vercel Pro max) to avoid reconnection for most agent runs.
// The reconnect path (GET /api/agent-workflow/[id]/stream) handles runs that
// exceed 800s, but delivers buffered chunks as a burst rather than streaming,
// so we maximize the initial connection window to preserve smooth streaming UX.
export const maxDuration = 800;

export async function POST(req: NextRequest) {
  let chatId: string | undefined;

  try {
    const payload = await prepareAgentPayload(req, "agent");
    chatId = payload.chatId;

    const run = await start(agentWorkflow, [payload]);

    const useRedisStreaming = isRedisStreamingEnabled(payload.userId);

    if (useRedisStreaming) {
      // Redis streaming path: store rstream_{chatId} as active_stream_id
      // so the client reconnects via /api/agent-workflow/{chatId}/redis-stream.
      // Reset the Redis stream first so any stale chunks from a previous run
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
    }

    // Default Vercel Workflow streaming path
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
