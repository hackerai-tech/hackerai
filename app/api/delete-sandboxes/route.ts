import { Sandbox } from "@e2b/code-interpreter";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";

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

    // Kill each sandbox
    for (const sandbox of sandboxes) {
      try {
        await Sandbox.kill(sandbox.sandboxId);
      } catch (error) {
        console.error(`Failed to kill sandbox ${sandbox.sandboxId}:`, error);
        throw error;
      }
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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
