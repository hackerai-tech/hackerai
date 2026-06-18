import { Sandbox } from "@e2b/code-interpreter";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { isExpectedMissingResourceCleanupError } from "@/lib/utils/cleanup-errors";

export const maxDuration = 60;

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

    // List all sandboxes for this user
    const paginator = Sandbox.list({
      query: {
        metadata: {
          userID: userId,
        },
      },
    });

    const sandboxes = await paginator.nextItems();

    // Kill each sandbox. Treat terminal-state races as success so a refresh,
    // auto-pause, or concurrent cleanup does not fail the whole request.
    let killed = 0;
    let alreadyGone = 0;
    for (const sandbox of sandboxes) {
      try {
        await Sandbox.kill(sandbox.sandboxId);
        killed++;
      } catch (error) {
        if (isExpectedMissingResourceCleanupError(error)) {
          alreadyGone++;
          console.debug(
            `Sandbox ${sandbox.sandboxId} was already gone during delete`,
            error,
          );
          continue;
        }
        console.error(`Failed to kill sandbox ${sandbox.sandboxId}:`, error);
        throw error;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        total: sandboxes.length,
        killed,
        alreadyGone,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
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
