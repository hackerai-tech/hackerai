import { getRun } from "workflow/api";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  JsonToSseTransformStream,
} from "ai";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import type { NextRequest } from "next/server";

export const maxDuration = 800;

/**
 * Returns a 200 response with an empty stream containing a "finish" event.
 * WorkflowChatTransport's reconnect loop requires a "finish" chunk to
 * terminate cleanly — a 204 (no body) would be treated as an error and retried.
 */
function emptyFinishResponse() {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "finish", finishReason: "stop" });
    },
  });
  return new Response(stream.pipeThrough(new JsonToSseTransformStream()), {
    status: 200,
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: runId } = await params;

  const { userId } = await getUserIDAndPro(req);
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!runId) {
    return new Response("Missing run ID", { status: 400 });
  }

  try {
    const run = getRun(runId);

    // Check if the run is still active
    const status = await run.status;
    if (status !== "running") {
      // Run completed — return an empty stream with a finish event so
      // WorkflowChatTransport's reconnect loop terminates cleanly.
      return emptyFinishResponse();
    }

    const { searchParams } = new URL(req.url);
    const startIndexParam = searchParams.get("startIndex");
    const startIndex = startIndexParam
      ? Math.max(0, parseInt(startIndexParam, 10) || 0)
      : undefined;

    const stream = run.getReadable({ startIndex });

    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    console.error("Failed to reconnect to workflow stream:", error);
    // Return an empty finish stream so the transport doesn't retry endlessly
    return emptyFinishResponse();
  }
}
