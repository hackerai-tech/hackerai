import { getRun } from "workflow/api";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import type { NextRequest } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);
    if (!userId) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { runId } = await req.json();
    if (!runId || typeof runId !== "string") {
      return new Response("Missing runId", { status: 400 });
    }

    const run = getRun(runId);
    const status = await run.status;
    if (status !== "running") {
      return new Response("OK", { status: 200 });
    }
    await run.cancel();

    return new Response("OK", { status: 200 });
  } catch (error: any) {
    if (error?.status === 409) {
      return new Response("OK", { status: 200 });
    }
    console.error("Failed to cancel workflow run:", error);
    return new Response("Failed to cancel", { status: 500 });
  }
}
