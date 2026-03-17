import { getRun } from "workflow/api";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { markStreamDone } from "@/lib/utils/redis-stream";
import type { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { runId, chatId } = await req.json();
    if (!runId || typeof runId !== "string") {
      return new Response("Missing runId", { status: 400 });
    }

    const run = getRun(runId);
    const status = await run.status;
    if (status !== "running") {
      return new Response("OK", { status: 200 });
    }
    await run.cancel();

    // Write __done sentinel so the Redis stream reader exits cleanly.
    // The workflow cancel may kill the step before its cleanup code runs.
    if (chatId && typeof chatId === "string") {
      void markStreamDone(chatId);
    }

    return new Response("OK", { status: 200 });
  } catch (error: any) {
    if (error?.status === 409) {
      return new Response("OK", { status: 200 });
    }
    console.error("Failed to cancel workflow run:", error);
    return new Response("Failed to cancel", { status: 500 });
  }
}
