import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { terminateCloudSandboxesForUser } from "@/lib/ai/tools/utils/cloud-sandbox";
import { getActiveTriggerRunsForUser } from "@/lib/db/actions";
import { cancelSubagentsForUserDeletion } from "@/lib/db/subagents";
import { closeAndCancelAgentResources } from "@/lib/api/agent-deletion-cleanup";

export const maxDuration = 60;
const SANDBOX_DELETION_REASON = "terminal-sandbox-deleted";

export async function POST(req: NextRequest) {
  try {
    const { userId, subscription } = await getUserIDAndPro(req);

    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Only allow subscribed users to delete sandboxes
    if (subscription === "free") {
      return new Response(JSON.stringify({ error: "Subscription required" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }

    const activeAgentResources = await getActiveTriggerRunsForUser({ userId });
    if (activeAgentResources.hasMore) {
      return new Response(
        JSON.stringify({
          error:
            "Too many active Agent runs to stop safely. Please retry deletion.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    const childCancellation = await cancelSubagentsForUserDeletion(
      userId,
      SANDBOX_DELETION_REASON,
    );
    if (childCancellation.hasMore) {
      return new Response(
        JSON.stringify({
          error:
            "Too many active validation runs to stop safely. Please retry deletion.",
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }

    await closeAndCancelAgentResources(
      [
        ...activeAgentResources.runs,
        ...childCancellation.triggerRunIds.map((triggerRunId) => ({
          chatId: "subagent",
          triggerRunId,
        })),
      ],
      SANDBOX_DELETION_REASON,
    );
    await terminateCloudSandboxesForUser(userId);

    // Cleanup counts and provider details are operational telemetry. A 204 is
    // sufficient for the client to confirm that the requested deletion
    // completed without exposing internal sandbox topology.
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Error deleting sandboxes:", error);
    return new Response(
      JSON.stringify({ error: "Failed to delete sandboxes" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
