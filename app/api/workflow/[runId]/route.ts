import { NextRequest, NextResponse } from "next/server";
import { getRun } from "workflow/api";
import { getUserID } from "@/lib/auth/get-user-id";
import { ChatSDKError } from "@/lib/errors";

export const runtime = "nodejs";
export const maxDuration = 30;

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

  const run = getRun(runId);
  const [status, exists] = await Promise.all([run.status, run.exists]);
  return NextResponse.json({ runId, status, exists });
}
