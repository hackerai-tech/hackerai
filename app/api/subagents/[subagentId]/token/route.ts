import { auth } from "@trigger.dev/sdk";
import { NextRequest, NextResponse } from "next/server";

import { getUserID } from "@/lib/auth/get-user-id";
import { getOwnedSubagent } from "@/lib/db/subagents";
import { AGENT_UI_STREAM_ID } from "@/trigger/stream-ids";

export const maxDuration = 30;
export const dynamic = "force-dynamic";
const SUBAGENT_TOKEN_TTL_SECONDS = 10 * 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ subagentId: string }> },
) {
  const { subagentId } = await params;
  if (!subagentId) {
    return NextResponse.json(
      { error: "Subagent ID required" },
      { status: 400 },
    );
  }

  let userId: string;
  try {
    userId = await getUserID(req);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let child: Awaited<ReturnType<typeof getOwnedSubagent>>;
  try {
    child = await getOwnedSubagent(subagentId, userId);
  } catch {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }
  if (!child.trigger_run_id) {
    return NextResponse.json(
      { error: "Child run has not started" },
      { status: 409 },
    );
  }

  try {
    const accessToken = await auth.createPublicToken({
      scopes: { read: { runs: [child.trigger_run_id] } },
      expirationTime: `${SUBAGENT_TOKEN_TTL_SECONDS}s`,
    });
    return NextResponse.json(
      {
        accessToken,
        runId: child.trigger_run_id,
        streamId: AGENT_UI_STREAM_ID,
        expiresInSeconds: SUBAGENT_TOKEN_TTL_SECONDS,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Could not create realtime access" },
      { status: 502 },
    );
  }
}
