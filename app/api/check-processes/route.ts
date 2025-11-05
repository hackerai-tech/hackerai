import { Sandbox } from "@e2b/code-interpreter";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
import {
  checkProcessesBatch,
  type ProcessCheckRequest,
} from "@/lib/ai/tools/utils/batch-process-checker";

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
    const { processes } = body;

    if (!Array.isArray(processes) || processes.length === 0) {
      return new Response(
        JSON.stringify({ error: "Invalid processes array" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Validate each process request
    const requests: ProcessCheckRequest[] = [];
    for (const proc of processes) {
      if (!proc.pid || typeof proc.pid !== "number") {
        return new Response(
          JSON.stringify({ error: `Invalid PID: ${proc.pid}` }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      if (!proc.command || typeof proc.command !== "string") {
        return new Response(
          JSON.stringify({ error: `Invalid command for PID ${proc.pid}` }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      requests.push({
        pid: proc.pid,
        expectedCommand: proc.command,
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
      // No sandbox exists, all processes are not running
      return new Response(
        JSON.stringify({
          results: requests.map((req) => ({
            pid: req.pid,
            running: false,
            command: req.expectedCommand,
            message: "No active sandbox found",
          })),
        }),
        {
          status: 200,
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
          results: requests.map((req) => ({
            pid: req.pid,
            running: false,
            command: req.expectedCommand,
            message: "Could not connect to sandbox",
          })),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    // Check all processes at once using batch checker
    const results = await checkProcessesBatch(sandbox, requests);

    return new Response(
      JSON.stringify({
        results: results.map((result) => ({
          pid: result.pid,
          running: result.running,
          command: requests.find((r) => r.pid === result.pid)?.expectedCommand,
          actualCommand: result.actualCommand,
          commandMatches: result.commandMatches,
          message: result.running
            ? result.commandMatches
              ? "Process is running"
              : `Process running with different command: ${result.actualCommand}`
            : "Process not found",
        })),
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

    console.error("Error checking processes:", error);
    return new Response(
      JSON.stringify({ error: "Failed to check processes" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
