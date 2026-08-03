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

  if (!SUBAGENT_ACTIVE_STATUSES.has(child.status)) {
    return NextResponse.json({ canceled: false, status: child.status });
  }
  if (!child.trigger_run_id) {
    try {
      const canceled = await cancelSubagentForUser({
        subagentId,
        userId,
        triggerRunId: undefined,
        reason: "user_canceled_child",
      });
      if (canceled) {
        return NextResponse.json({ canceled: true, status: child.status });
      }
      child = await getOwnedSubagent(subagentId, userId);
      if (!SUBAGENT_ACTIVE_STATUSES.has(child.status)) {
        return NextResponse.json({ canceled: false, status: child.status });
      }
      if (!child.trigger_run_id) {
        return NextResponse.json(
          { canceled: false, status: child.status },
          { status: 409 },
        );
      }
    } catch {
      return NextResponse.json(
        { error: "Could not cancel subagent" },
        { status: 502 },
      );
    }
  }

  try {
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
    return NextResponse.json(
      { error: "Could not cancel subagent" },
      { status: 502 },
    );
  }
}
