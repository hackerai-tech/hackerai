import { generateId } from "ai";
import type { ResumableStreamContext } from "resumable-stream";
import { startStream } from "@/lib/db/actions";
import { phLogger } from "@/lib/posthog/server";

type ChatStreamResumptionOptions = {
  chatId: string;
  stream: ReadableStream<string>;
  getStreamContext: () => Pick<
    ResumableStreamContext,
    "createNewResumableStream"
  > | null;
};

/** Best-effort resumability must not retry a registration with unknown commit state. */
export async function setupChatStreamResumption({
  chatId,
  stream: sseStream,
  getStreamContext,
}: ChatStreamResumptionOptions): Promise<void> {
  let phase: "context" | "generate_id" | "register" | "create_stream" =
    "context";
  let streamId: string | undefined;
  try {
    const streamContext = getStreamContext();
    if (streamContext) {
      phase = "generate_id";
      streamId = generateId();
      phase = "register";
      await startStream({ chatId, streamId });
      phase = "create_stream";
      await streamContext.createNewResumableStream(streamId, () => sseStream);
    }
  } catch (error) {
    // Non-fatal: stream still works without resumability
    phLogger.warn("Stream resumption setup failed", {
      chatId,
      stream_resumption_diagnostic_version: 1,
      stream_resumption_phase: phase,
      stream_id: streamId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
