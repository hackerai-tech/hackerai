import { auth } from "@trigger.dev/sdk";
import { NextRequest, NextResponse } from "next/server";

import { getUserID } from "@/lib/auth/get-user-id";
import { getOwnedSubagent } from "@/lib/db/subagents";
import { AGENT_UI_STREAM_ID } from "@/trigger/stream-ids";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ subagentId: string }> },
) {
  try {
    const { subagentId } = await params;
    if (!subagentId) {
      return NextResponse.json(
        { error: "Subagent ID required" },
        { status: 400 },
      );
    }
    const userId = await getUserID(req);
    const child = await getOwnedSubagent(subagentId, userId);
    if (!child.trigger_run_id) {
      return NextResponse.json(
        { error: "Child run has not started" },
        { status: 409 },
      );
    }

    const accessToken = await auth.createPublicToken({
      scopes: { read: { runs: [child.trigger_run_id] } },
      expirationTime: "10m",
    });
    return NextResponse.json(
      {
        accessToken,
        runId: child.trigger_run_id,
        streamId: AGENT_UI_STREAM_ID,
        expiresInSeconds: 600,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }
}
