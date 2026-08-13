import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { terminateCloudSandboxesForUser } from "@/lib/ai/tools/utils/cloud-sandbox";

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

    const { total, killed, alreadyGone } =
      await terminateCloudSandboxesForUser(userId);

    return new Response(
      JSON.stringify({
        success: true,
        total,
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
