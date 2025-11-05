import { Sandbox } from "@e2b/code-interpreter";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { forceKillProcess } from "@/lib/ai/tools/utils/process-termination";
import { ChatSDKError } from "@/lib/errors";

export const maxDuration = 60;

const SANDBOX_TEMPLATE = process.env.E2B_TEMPLATE || "terminal-agent-sandbox";

export async function POST(req: NextRequest) {
  try {
    const { userId } = await getUserIDAndPro(req);

    if (!userId) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const { pid } = body;

    if (!pid || typeof pid !== "number") {
      return new Response(JSON.stringify({ error: "Invalid PID" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Find the user's sandbox
    const paginator = Sandbox.list({
      query: {
        metadata: {
          userID: userId,
          template: SANDBOX_TEMPLATE,
        },
      },
    });

    const existingSandbox = (await paginator.nextItems())[0];

    if (!existingSandbox) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "No active sandbox found",
        }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Connect to the sandbox
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.connect(existingSandbox.sandboxId);
    } catch (error) {
      return new Response(
        JSON.stringify({
          success: false,
          message: "Could not connect to sandbox",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Kill the process using force kill
    const killed = await forceKillProcess(sandbox, pid);

    return new Response(
      JSON.stringify({
        success: killed,
        pid,
        message: killed
          ? "Process killed successfully"
          : "Failed to kill process (may not exist)",
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    // Handle authentication errors with proper 401 status
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }

    console.error("Error killing process:", error);
    return new Response(
      JSON.stringify({ error: "Failed to kill process" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
