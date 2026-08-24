import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { terminateCloudSandboxesForUser } from "@/lib/ai/tools/utils/cloud-sandbox";
import {
  beginCloudSandboxDeletionForUser,
  finishCloudSandboxDeletionForUser,
  getActiveTriggerRunsForUser,
} from "@/lib/db/actions";
import { cancelSubagentsForUserDeletion } from "@/lib/db/subagents";
import { closeAndCancelAgentResources } from "@/lib/api/agent-deletion-cleanup";

export const maxDuration = 60;
const SANDBOX_DELETION_REASON = "terminal-sandbox-deleted";

export async function POST(req: NextRequest) {
  let deletionFence: { userId: string; operationId: string } | undefined;
  const requestId =
    req.headers?.get("x-request-id") ??
    req.headers?.get("x-vercel-id") ??
    crypto.randomUUID();
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

    const fence = await beginCloudSandboxDeletionForUser({ userId });
    if (!fence.acquired) {
      return new Response(
        JSON.stringify({ error: "Sandbox deletion is already in progress" }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    }
    deletionFence = { userId, operationId: fence.operationId };

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
  } finally {
    if (deletionFence) {
      try {
        await finishCloudSandboxDeletionForUser(deletionFence);
      } catch (error) {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: "error",
            event: "cloud_sandbox_deletion_fence_release_failed",
            request_id: requestId,
            service: "delete-sandboxes-api",
            environment:
              process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
            user_id: deletionFence.userId,
            error_name: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
    }
  }
}
