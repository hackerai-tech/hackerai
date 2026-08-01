import { NextRequest, NextResponse } from "next/server";

import { getUserID } from "@/lib/auth/get-user-id";
import { cancelAgentTriggerRun } from "@/lib/api/agent-approval-session";
import { cancelSubagentForUser, getOwnedSubagent } from "@/lib/db/subagents";
import { SUBAGENT_ACTIVE_STATUSES } from "@/lib/ai/subagents/contracts";

export const maxDuration = 30;

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
    if (!SUBAGENT_ACTIVE_STATUSES.has(child.status)) {
      return NextResponse.json({ canceled: false, status: child.status });
    }
    if (!child.trigger_run_id) {
      return NextResponse.json(
        { canceled: false, status: child.status },
        { status: 409 },
      );
    }
    const canceled = await cancelAgentTriggerRun(child.trigger_run_id);
    if (canceled) {
      await cancelSubagentForUser({
        subagentId,
        userId,
        triggerRunId: child.trigger_run_id,
        reason: "user_canceled_child",
      });
    }
    return NextResponse.json({ canceled, status: child.status });
  } catch {
    return NextResponse.json({ error: "Subagent not found" }, { status: 404 });
  }
}
