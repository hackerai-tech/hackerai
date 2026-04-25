import { NextRequest } from "next/server";
import { getRun } from "workflow/api";
import { JsonToSseTransformStream } from "ai";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  try {
    await getUserID(req);
  } catch (error) {
    if (error instanceof ChatSDKError) return error.toResponse();
    return new ChatSDKError("unauthorized:auth").toResponse();
  }

  const { runId } = await params;
  if (!runId) {
    return new ChatSDKError("bad_request:api", "Missing runId").toResponse();
  }

  const url = new URL(req.url);
  const startIndex = Number(url.searchParams.get("startIndex") ?? 0) || 0;

  const run = getRun(runId);
  const objectStream = run.getReadable({ startIndex });
  const sseStream = objectStream.pipeThrough(new JsonToSseTransformStream());

  return new Response(sseStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Transfer-Encoding": "chunked",
      "X-Accel-Buffering": "no",
    },
  });
}
